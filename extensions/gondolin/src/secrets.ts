/**
 * Credential discovery and guest-env sanitization for the HTTP proxy.
 *
 * The agent running inside the VM must never see real API keys. Instead we
 * discover credentials present in the host environment, hand the guest opaque
 * *stubs* (placeholders), and let gondolin's HTTP hooks inflate the stubs back
 * into the real values in outbound headers — but only for each credential's
 * allowed hosts. Any request that does not carry a known stub (including one
 * that carries a real, non-stub key) passes through untouched.
 */

import { randomBytes } from "node:crypto";
import type { GondolinConfig, SecretSpec } from "./config.ts";

export interface DiscoveredSecret {
	/** Guest-visible env var name (the stub is exposed under this name). */
	name: string;
	/** Host env var the real value was read from. */
	envVar: string;
	/** Host patterns this credential may be inflated for. */
	hosts: string[];
	/** Real credential value, held host-side only. */
	value: string;
	/** Guest-visible placeholder substituted into outbound requests. */
	placeholder: string;
}

/**
 * Well-known API-key environment variables and the hosts their credentials are
 * valid for. Used only when `httpProxy.discoverKnownSecrets` is true; values are
 * always read from the host environment, never from config.
 */
export const KNOWN_SECRET_HOSTS: Record<string, string[]> = {
	// LLM / AI providers
	ANTHROPIC_API_KEY: ["api.anthropic.com"],
	ANTHROPIC_AUTH_TOKEN: ["api.anthropic.com"],
	OPENAI_API_KEY: ["api.openai.com"],
	GEMINI_API_KEY: ["generativelanguage.googleapis.com"],
	GOOGLE_API_KEY: ["generativelanguage.googleapis.com"],
	GOOGLE_GENERATIVE_AI_API_KEY: ["generativelanguage.googleapis.com"],
	GROQ_API_KEY: ["api.groq.com"],
	MISTRAL_API_KEY: ["api.mistral.ai"],
	OPENROUTER_API_KEY: ["openrouter.ai"],
	DEEPSEEK_API_KEY: ["api.deepseek.com"],
	TOGETHER_API_KEY: ["api.together.xyz"],
	TOGETHER_AI_API_KEY: ["api.together.xyz"],
	FIREWORKS_API_KEY: ["api.fireworks.ai"],
	COHERE_API_KEY: ["api.cohere.com"],
	XAI_API_KEY: ["api.x.ai"],
	GROK_API_KEY: ["api.x.ai"],
	PERPLEXITY_API_KEY: ["api.perplexity.ai"],
	CEREBRAS_API_KEY: ["api.cerebras.ai"],
	// Model hubs
	HF_TOKEN: ["huggingface.co"],
	HUGGINGFACE_HUB_TOKEN: ["huggingface.co"],
	HUGGING_FACE_HUB_TOKEN: ["huggingface.co"],
	HF_API_TOKEN: ["huggingface.co"],
	// Code / package registries
	GITHUB_TOKEN: ["api.github.com", "github.com"],
	GH_TOKEN: ["api.github.com", "github.com"],
	GH_PAT: ["api.github.com", "github.com"],
	GITLAB_TOKEN: ["gitlab.com"],
	GITLAB_PAT: ["gitlab.com"],
	NPM_TOKEN: ["registry.npmjs.org"],
	CARGO_REGISTRY_TOKEN: ["crates.io", "static.crates.io", "index.crates.io"],
	GEM_HOST_API_KEY: ["rubygems.org"],
	PYPI_TOKEN: ["upload.pypi.org", "pypi.org"],
	POETRY_PYPI_TOKEN_PYPI: ["upload.pypi.org", "pypi.org"],
	TWINE_PASSWORD: ["upload.pypi.org", "pypi.org"],
	// Cloud / infra
	CLOUDFLARE_API_TOKEN: ["api.cloudflare.com"],
	CF_API_TOKEN: ["api.cloudflare.com"],
	CLOUDFLARE_API_KEY: ["api.cloudflare.com"],
	VERCEL_TOKEN: ["api.vercel.com"],
	NETLIFY_AUTH_TOKEN: ["api.netlify.com"],
	DIGITALOCEAN_ACCESS_TOKEN: ["api.digitalocean.com"],
	SENTRY_AUTH_TOKEN: ["sentry.io"],
	DATADOG_API_KEY: ["api.datadoghq.com"],
	DD_API_KEY: ["api.datadoghq.com"],
	STRIPE_SECRET_KEY: ["api.stripe.com"],
	STRIPE_API_KEY: ["api.stripe.com"],
};

const DENYLIST = new Set([
	"",
	"test",
	"dummy",
	"placeholder",
	"changeme",
	"example",
	"xxx",
	"todo",
	"secret",
	"your_api_key",
	"your_token",
	"your_api_key_here",
	"your_token_here",
]);

/** A value worth treating as a credential: non-trivial, whitespace-free, not a sentinel. */
export function looksLikeSecretValue(value: unknown): value is string {
	if (typeof value !== "string") return false;
	if (value.length < 8) return false;
	if (/\s/.test(value)) return false;
	if (DENYLIST.has(value.toLowerCase())) return false;
	return true;
}

export interface RandomSource {
	/** Return `length` hex characters of randomness. */
	hex(length: number): string;
}

/** Default random source backed by `crypto.randomBytes`. */
export const cryptoRandomSource: RandomSource = {
	hex(length: number): string {
		const bytes = Math.ceil(length / 2);
		return randomBytes(bytes).toString("hex").slice(0, length);
	},
};

function makePlaceholder(name: string, random: RandomSource): string {
	return `gondolin-stub-${name}-${random.hex(16)}`;
}

interface Candidate {
	name: string;
	envVar: string;
	hosts: string[];
}

function candidates(config: GondolinConfig): Map<string, Candidate> {
	const map = new Map<string, Candidate>();
	if (config.httpProxy.discoverKnownSecrets) {
		for (const [name, hosts] of Object.entries(KNOWN_SECRET_HOSTS)) {
			map.set(name, { name, envVar: name, hosts });
		}
	}
	for (const [name, spec] of Object.entries(config.httpProxy.secrets)) {
		map.set(name, { name, envVar: spec.envVar ?? name, hosts: spec.hosts });
	}
	return map;
}

/**
 * Discover credentials from the host environment and assign each a stub.
 * Returns entries in a stable (catalog-then-config, alphabetical) order.
 */
export function discoverSecrets(
	env: NodeJS.ProcessEnv,
	config: GondolinConfig,
	random: RandomSource = cryptoRandomSource,
): DiscoveredSecret[] {
	if (!config.httpProxy.enabled) return [];
	const seen = new Map<string, DiscoveredSecret>();
	for (const candidate of candidates(config).values()) {
		const value = env[candidate.envVar];
		if (!looksLikeSecretValue(value)) continue;
		// Never expose the extension's own config channel as a credential.
		if (candidate.envVar.startsWith("PI_GONDOLIN_")) continue;
		seen.set(candidate.name, {
			name: candidate.name,
			envVar: candidate.envVar,
			hosts: candidate.hosts,
			value,
			placeholder: makePlaceholder(candidate.name, random),
		});
	}
	return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Gondolin `secrets` map: real values + stubs, keyed by guest env var name. */
export function buildSecretDefinitions(secrets: DiscoveredSecret[]): Record<string, { hosts: string[]; value: string; placeholder: string }> {
	const out: Record<string, { hosts: string[]; value: string; placeholder: string }> = {};
	for (const secret of secrets) out[secret.name] = { hosts: secret.hosts, value: secret.value, placeholder: secret.placeholder };
	return out;
}

/** Guest env exposing only stubs (never real values). */
export function buildStubEnv(secrets: DiscoveredSecret[]): Record<string, string> {
	const env: Record<string, string> = {};
	for (const secret of secrets) env[secret.name] = secret.placeholder;
	return env;
}

/**
 * Replace every occurrence of a real credential value with its stub. Used on
 * host env that is otherwise passed through to the guest, so an embedded key
 * (e.g. in a URL or `_authToken` config var) is scrubbed before the guest sees it.
 */
export function scrubValue(value: string, secrets: DiscoveredSecret[]): string {
	if (secrets.length === 0) return value;
	// Longest values first so a value that contains another is replaced wholesale.
	const ordered = [...secrets].sort((a, b) => b.value.length - a.value.length);
	let result = value;
	for (const secret of ordered) {
		if (result.includes(secret.value)) {
			result = result.split(secret.value).join(secret.placeholder);
		}
	}
	return result;
}

/**
 * Build the per-exec guest env from a host env: only `passthrough` names are
 * copied, and each copied value is scrubbed of any discovered credential.
 */
export function sanitizeGuestEnv(
	hostEnv: NodeJS.ProcessEnv | undefined,
	secrets: DiscoveredSecret[],
	passthrough: string[],
): Record<string, string> {
	const out: Record<string, string> = {};
	if (!hostEnv) return out;
	const allow = new Set(passthrough);
	for (const name of passthrough) {
		const value = hostEnv[name];
		if (typeof value === "string") out[name] = scrubValue(value, secrets);
	}
	return out;
}

/** Re-export for config-driven callers. */
export type { SecretSpec };
