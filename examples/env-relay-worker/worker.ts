import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, type Wake } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { RelayedExecutionEnv, webSocketTransport } from "@gkgo/pi-packages/env-relay";
import type { RelayTransport } from "@gkgo/pi-packages/env-relay";

/**
 * ILLUSTRATIVE EXAMPLE — not part of this repo's typecheck/build (Cloudflare
 * Workers types such as `cloudflare:workers` and `WebSocketPair` are not
 * installed here). Copy it into your Worker project as a starting point.
 *
 * Minimal Cloudflare Worker + Durable Object running a pi-durable Harness
 * whose tools execute on a connected development box through the env relay.
 *
 * The dev box dials OUT (no inbound connectivity needed):
 *
 *   import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
 *   import { serveEnvRelay, connectWebSocketRelay } from "@gkgo/pi-packages/env-relay/node";
 *
 *   const transport = await connectWebSocketRelay("wss://your-worker.example.dev/env/dev-box-1");
 *   serveEnvRelay(new NodeExecutionEnv({ cwd: process.cwd() }), transport, {
 *     token: process.env.ENV_RELAY_TOKEN,   // must match the Worker's secret
 *     root: process.cwd(),                  // jail the relay to the project
 *   });
 *
 * The Worker routes each dev box's WebSocket to its Durable Object; the DO
 * accepts it (with hibernation, so the object can sleep between turns) and
 * `HarnessOptions.env` builds a RelayedExecutionEnv over the live transport.
 * Wrap it in `FallbackExecutionEnv` to fail over to a second env when the dev
 * box is unreachable.
 */

interface Env {
	ENV_RELAY_TOKEN: string;
	SESSIONS: DurableObjectNamespace<SessionDO>;
}

export class SessionDO extends DurableObject<Env> {
	#harness!: Harness;
	#transport: RelayTransport | undefined;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		void ctx.blockConcurrencyWhile(async () => {
			const models = createModels();
			// Register your providers on `models` here (e.g. openaiProvider()).
			const registry = createRegistry();
			registry.install(CodingTools);
			const storage = await openDurableObjectSqliteStorage(ctx.storage);
			const harness = await Harness.open(storage, {
				models,
				registry,
				env: ({ cwd }) => {
					const transport = this.#transport;
					if (!transport) throw new Error("no dev box connected");
					return new RelayedExecutionEnv({
						id: "dev-box-1",
						cwd: cwd ?? "/",
						token: env.ENV_RELAY_TOKEN,
						connect: () => Promise.resolve(transport),
					});
				},
				onWake: (wake: Wake) => void this.#arm(wake),
			}, BACKGROUND_CONTEXT);
			this.#harness = harness;
			await this.#arm(harness.wake());
			harness.resume();
		});
	}

	async #arm(wake: Wake): Promise<void> {
		const heartbeat = wake.active ? Date.now() + 60_000 : undefined;
		const at = heartbeat === undefined || wake.at === undefined ? (heartbeat ?? wake.at) : Math.min(heartbeat, wake.at);
		if (at === undefined) await this.ctx.storage.deleteAlarm();
		else await this.ctx.storage.setAlarm(at);
	}

	// Dev-box WebSocket termination: /env/<box> upgrades here.
	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
		if (request.headers.get("Authorization") !== `Bearer ${this.env.ENV_RELAY_TOKEN}`) {
			return new Response("unauthorized", { status: 401 });
		}
		const pair = new WebSocketPair();
		this.ctx.acceptWebSocket(pair[1]);
		this.#transport = webSocketTransport(pair[1]);
		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	override async alarm(): Promise<void> {
		await this.#arm({ ...this.#harness.wake(), active: true });
		this.#harness.resume();
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname.startsWith("/env/")) {
			const box = url.pathname.slice("/env/".length);
			return env.SESSIONS.get(env.SESSIONS.idFromName(box)).fetch(request);
		}
		return new Response("not found", { status: 404 });
	},
};
