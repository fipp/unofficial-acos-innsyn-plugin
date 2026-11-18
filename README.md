# unofficial-acos-innsyn-plugin

Search and download from Norwegian kommuner's public journals on **ACOS Innsyn+** (`innsynpluss.onacos.no`): byggesaker, delesaker, plansaker, postlister and politiske saker. It works from Claude Code, Codex, Gemini CLI, Cursor or any MCP client, and from the command line.

> **Unofficial.** Not affiliated with or endorsed by ACOS AS or any kommune. It uses the same JSON calls the public Innsyn+ web page makes. They are undocumented and may change without notice.

## What it does

- **Search** a kommune's journal by gårds-/bruksnummer, title (e.g. a street address), free text, saks-/dokumentID or sender/recipient, across all its data sources (old and new archives).
- **Read** a case (arkivsak) with its published documents, and a document (journalpost) with its files.
- **Download** all files of a document or a whole case, named `YYYY-MM-DD_<title> (<DokumentID>).pdf`. Files that are not published are flagged `orderOnly` so you know to send an innsynskrav.
- **Knows 52 kommuner** (see the table below) and can discover others by slug on the fly.

No dependencies: Node ≥ 18.17 only. [Playwright](https://playwright.dev) is optional and needed only for file downloads (see *How it works*).

## Install

### Claude Code (plugin)

```
/plugin marketplace add fipp/unofficial-acos-innsyn-plugin
/plugin install acos-innsyn@unofficial-acos-innsyn
```

This adds the MCP server and the `acos-innsyn` skill (search method and etiquette).

### Codex, Gemini CLI, Cursor and other MCP clients

Clone the repo and point the client at `src/mcp.js`:

```sh
git clone https://github.com/fipp/unofficial-acos-innsyn-plugin.git ~/src/unofficial-acos-innsyn-plugin
```

- **Codex** (`~/.codex/config.toml`):
  ```toml
  [mcp_servers.acos-innsyn]
  command = "node"
  args = ["/home/you/src/unofficial-acos-innsyn-plugin/src/mcp.js"]
  ```
- **Gemini CLI** (`~/.gemini/settings.json`) and **Cursor** (`.cursor/mcp.json`):
  ```json
  { "mcpServers": { "acos-innsyn": { "command": "node", "args": ["/home/you/src/unofficial-acos-innsyn-plugin/src/mcp.js"] } } }
  ```

`AGENTS.md` and `skills/acos-innsyn/SKILL.md` give agents the search method.

### For downloads: Playwright

```sh
npm i -g playwright && npx playwright install chromium
```

The tool finds a global install, one next to the plugin or in the server's working directory, or the module path in `ACOS_PLAYWRIGHT_MODULE`. Restart the MCP server after installing.

Each Playwright version needs one specific Chromium build. In an environment that ships browsers in a fixed `PLAYWRIGHT_BROWSERS_PATH` (many Docker images), install the Playwright version that matches those browsers rather than the latest; the tool explains a mismatch when it happens.

## CLI

```sh
node src/cli.js portals --with-source bygg            # kommuner that publish byggesaker
node src/cli.js sources baerum                        # data sources of one portal
node src/cli.js search baerum --gnr 12/345 --source bygg
node src/cli.js search ullensaker --title "Storgata 1" --cases
node src/cli.js case baerum 'a-…'                     # case + document list
node src/cli.js doc baerum 'd-…'                      # document + files
node src/cli.js download baerum 'a-…' --out ./saker   # whole case
```

Output is JSON. `KOMMUNE` can be a slug (`baerum`), a name (`Bærum`) or a kommunenummer (`3201`).

### MCP tools

| Tool | Purpose |
|---|---|
| `list_portals` | Known kommuner and their data sources, optionally filtered (`with_source: "bygg"`) |
| `list_sources` | One portal's data sources |
| `search` | At least one of `gnr_bnr`, `title`, `text`, `case_or_doc_id`, `party`; plus `source`, `cases_only`, `max` (default 50 per source) |
| `get_case` | Case with date, type, handler, status and documents; `with_files` adds file count and `orderOnly` per document |
| `get_document` | Document with dates and files (`orderOnly` if none) |
| `download` | Files of a document or a whole case into `out_dir` |

## How it works

1. Opening a kommune's search page gives a session cookie. With it, the portal's JSON endpoints answer plain HTTP: `overviewInit` (data sources, filters), `overview` (search), `sak/<id>` and `dokument/<id>`.
2. File downloads (`filer/<id>`) sit behind an **Azure WAF JavaScript challenge**. When a plain request is challenged, the tool opens that file once in headless Chromium, so the challenge runs exactly as in any browser, and either saves the file or keeps the clearance cookie for the next plain requests. It does **not** disguise the browser or try to defeat the firewall.
3. If the firewall still refuses, the tool stops and says to wait. In testing (November 2026) a burst of roughly 7-25 files went through before the firewall paused downloads for a while. Run the same `download` again later: files already on disk are skipped.

Requests are throttled: 600 ms between API calls, 2 s between files (`ACOS_INNSYN_DELAY_MS`, `ACOS_INNSYN_FILE_DELAY_MS`). Please keep it that way: these are kommunal servers.

### Why not an official API?

- **ACOS** publishes no public API for Innsyn+.
- **[eInnsyn](https://github.com/felleslosninger/einnsyn-api-spec)** has a proper open API, but many kommuner publish their byggesaker only on Innsyn+, and eInnsyn mostly carries metadata, not files.

eInnsyn is still the right place for state bodies (Statsforvalteren, Statens vegvesen, Bane NOR), so an eInnsyn backend is a natural next step.

## Use responsibly

- This only reaches what the kommune has already published. Documents marked `orderOnly` must be requested by innsynskrav (offentleglova § 3) to the kommune.
- Journal entries contain personal data. Use what you fetch for your own case or for journalism and research within personvern rules, not for profiling people.

## Kommuner

| Nr | Kommune | Slug | Data sources | Byggesaker |
|---|---|---|---|---|
| 1112 | Lund | `lund` | Arkiv fra 2023 til i dag; Historisk arkiv 2007-2022 | yes |
| 1580 | Haram | `haram` | Journal | yes |
| 1837 | Meløy | `meloy` | Journal | yes |
| 1839 | Beiarn | `beiarn` | Journal | yes |
| 1841 | Fauske | `fauske` | Journal | yes |
| 3116 | Skiptvet | `skiptvet` | Journal | yes |
| 3122 | Marker | `marker` | Journal | yes |
| 3201 | Bærum | `baerum` | Postliste; Politiske saker fra 2015; Plan- og byggesaker fra 2015; Politiske saker 2003-2015; Plan- og byggesaker 2003-2015; Rørleggerarkiv 1880-2007 | yes |
| 3209 | Ullensaker | `ullensaker` | Journal | yes |
| 3228 | Nes | `nes` | Journal | yes |
| 3230 | Gjerdrum | `gjerdrum` | Innsyn Gjerdrum Postliste; Innsyn Gjerdrum Historisk 01 | yes |
| 3234 | Lunner | `lunner` | Arkiv fra 2019 til d.d.; Møtesaker fra før 2019 | yes |
| 3236 | Jevnaker | `jevnaker` | (no journal found) | not labelled |
| 3238 | Nannestad | `nannestad` | Journal | yes |
| 3240 | Eidsvoll | `eidsvoll` | Journal | yes |
| 3242 | Hurdal | `hurdal` | Journal | yes |
| 3305 | Ringerike | `ringerike` | Journal | yes |
| 3310 | Hole | `hole` | Saker fra mai 2026; Historiske saker 2007-2026 | yes |
| 3316 | Modum | `modum` | Arkiv fra mai 2021; Historisk arkiv 2013-2021 | yes |
| 3416 | Eidskog | `eidskog` | Journal | not labelled |
| 3430 | Os | `os` | Journal | yes |
| 3447 | Søndre Land | `sondre-land` | Journal | yes |
| 3448 | Nordre Land | `nordre-land` | Journal | yes |
| 3909 | Larvik | `larvik` | Postliste; Politiske saker | yes |
| 4001 | Porsgrunn | `porsgrunn` | Arkiv fra 2023; Historisk arkiv 2012-2023; Historisk arkiv 1996-2012 | yes |
| 4003 | Skien | `skien` | Saker fra juni 2023; Historiske saker 2013-2023 | yes |
| 4010 | Siljan | `siljan` | Journal | yes |
| 4012 | Bamble | `bamble` | Journal | yes |
| 4016 | Drangedal | `drangedal` | Saker fra juni 2023; Historiske saker 2012-2023 | yes |
| 4215 | Lillesand | `lillesand` | Journal | yes |
| 4216 | Birkenes | `birkenes` | Journal | yes |
| 4225 | Lyngdal | `lyngdal` | Journal | yes |
| 4228 | Sirdal | `sirdal` | Journal | yes |
| 4618 | Ullensvang | `ullensvang` | Postliste; Politiske saker; Ullensvang 2002-2019; Jondal 1998-2019; Odda 2001-2019 | yes |
| 4627 | Askøy | `askoy` | Journal | yes |
| 4642 | Lærdal | `lardal` | Journal | yes |
| 5025 | Røros | `roros` | Journal | yes |
| 5503 | Harstad | `harstad` | Journal | yes |
| 5510 | Kvæfjord | `kvafjord` | Journal | yes |
| 5522 | Salangen | `salangen` | Journal | yes |
| 5524 | Målselv | `malselv` | Journal | yes |
| 5526 | Sørreisa | `sorreisa` | Journal | yes |
| 5532 | Balsfjord | `balsfjord` | Journal | yes |
| 5536 | Lyngen | `lyngen` | Journal | yes |
| 5538 | Storfjord | `storfjord` | Journal | yes |
| 5542 | Skjervøy | `skjervoy` | Journal | yes |
| 5544 | Nordreisa | `nordreisa` | Journal | yes |
| 5546 | Kvænangen | `kvanangen` | (no journal found) | not labelled |
| 5618 | Måsøy | `masoy` | Journal | yes |
| 5620 | Nordkapp | `nordkapp` | Journal | yes |
| 5622 | Porsanger | `porsanger` | Journal | yes |
| 5624 | Lebesby | `lebesby` | Journal | yes |

Generated by `npm run registry` (probes every kommune in SSB's list against `innsynpluss.onacos.no/<slug>/`, then reads each portal's search page). "Journal" means a portal with one archive and no source menu. "Not labelled" means the portal does not name byggesaker as a source or sakstype; its journal may still contain them (Eidskog does). A kommune with an unusual slug may be missing; `search` also accepts unknown slugs and discovers them on the fly.

## Development

```sh
npm test                 # offline unit tests
npm run registry         # rebuild data/portals.json (a few minutes, rate limited)
ACOS_INNSYN_DEBUG=1 …    # log the browser's requests during the WAF step
```

## Licence

MIT. See `LICENSE`.
