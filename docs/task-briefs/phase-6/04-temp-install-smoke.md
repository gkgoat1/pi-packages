# Phase 6 — Temp-install Pi smoke

## 1. Where this task sits

- **Phase 6 Prepare and gate the scoped package release**: packing is not proof; installing and loading is.
- Moves **R-5 Publishable `@gkgo` scoped package metadata** into a real install+load check.
- Starts after the tarball gate; waits on the publish dry-run.

## 2. What the developer needs to know

**Read first**

- `test/package-preflight.test.mjs` — the dry-run gate.
- `test/workers-bundle.test.mjs` — the Pi-load smoke style.
- Phase 1's manual temp-install result: peers resolve, workers bundle loads.

**Settled**

- The smoke runs in `test:pi` (Pi-dependent), not the default `npm test` glob... it is a node test; keep it in `test/` but document the network/peers cost.
- The temp project gets the tarball plus the Pi host peers; the workers bundle must load under `pi`.
- No registry publish happens in this phase.

**Edges and seam**

- Adds `test/package-install.test.mjs`.
- Leaves `npm publish --dry-run` for the final task.
- Seam: `npm pack` → temp project → `npm install` → `pi --extension <installed bundle>`.

**Run**

- `node --test test/package-install.test.mjs`.
- `npm run check && npm test && npm run test:pi`.

**Unknowns**

- If peer install needs network, this test requires it; keep the timeout generous and the temp dir cleaned.

## 3. The workflow

1. Read this brief and restate the task: prove the scoped tarball installs and loads under Pi.
2. Write the test: pack, temp-install with peers, load the workers bundle.
3. Assert the workers command surface is present.
4. Run the test, the suite, and the Pi smoke suite.
5. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | packed tarball | installs into a temp project | npm install |
| 2 | installed package | `dist/workers/index.js` loads under `pi` | Pi extension load |
| 3 | installed manifest | name `@gkgo/pi-packages` with pi.extensions intact | package metadata |
| 4 | cleanup | temp project removed even on failure | test harness |
| 5 | peer resolution | host Pi packages resolve from the install | npm dependency tree |
