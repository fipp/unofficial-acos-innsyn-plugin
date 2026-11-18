# Agent instructions: unofficial-acos-innsyn

This repo is a dependency-free Node (>= 18.17) client, CLI and MCP server for Norwegian kommuner's public journals on ACOS Innsyn+ (innsynpluss.onacos.no).

**Using it from an agent (Codex, Gemini CLI, Cursor, Copilot, ...):**

- Prefer the MCP server: `node <repo>/src/mcp.js` (stdio). Tools: `list_portals`, `list_sources`, `search`, `get_case`, `get_document`, `download`.
- Or the CLI, which prints JSON: `node <repo>/src/cli.js help`.
- The search method and etiquette are in `skills/acos-innsyn/SKILL.md`. Read it before searching.

**Working on the code:**

- `src/client.js` talks to the portal's JSON endpoints (`/api/presentation/v2/nye-innsyn/{overviewInit,overview,sak/<id>,dokument/<id>,filer/<id>}`). These are the portal's own frontend calls, not a documented API, so keep parsing defensive.
- `src/discover.js` finds a kommune's search page, `portalID`/`menypunktID` and data sources. `scripts/build-registry.js` rebuilds `data/portals.json` from SSB's kommune list.
- Keep it dependency-free. Playwright is an optional peer, loaded lazily only for the Azure WAF challenge on file downloads. Never add browser fingerprint spoofing or other WAF evasion.
- Keep the default throttling. Run `npm test` (offline unit tests) before committing.
