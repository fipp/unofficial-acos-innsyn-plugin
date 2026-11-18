---
name: acos-innsyn
description: Search and download from Norwegian kommuner's public journals on ACOS Innsyn+ (innsynpluss.onacos.no) - byggesaker, delesaker, plansaker, postlister and politiske saker. Use when the user wants the case history of a property (gnr/bnr or address), a specific byggesak or dokument, letters from or to a person, or to fetch published PDFs from a kommune that uses Innsyn+ (e.g. Bærum, Ullensaker, Larvik, Skien, Porsgrunn, Askøy, Harstad).
---

# ACOS Innsyn+ (unofficial)

Tools (MCP server `acos-innsyn`): `list_portals`, `list_sources`, `search`, `get_case`, `get_document`, `download`.
Without MCP, run the same operations with the CLI: `node <plugin>/src/cli.js help`.

## How to search well

1. **Find the portal.** `list_portals` (use `with_source: "bygg"` for kommuner that publish byggesaker). A kommune is a slug (`baerum`), a name (`Bærum`) or a kommunenummer (`3201`). If a kommune is missing it may not use Innsyn+; say so rather than guessing.
2. **Check the data sources** with `list_sources`. Many portals split old and new archives (e.g. "Plan- og byggesaker 2003-2015" and "fra 2015"). Search all of them unless the user limits the period.
3. **Property history:** search `gnr_bnr` first ("12/345"). Then search the street address in `title` ("Storgata 1"), because older or neighbouring cases are often filed under the address or a neighbour's number. Then owners' names in `party`.
   Every search needs at least one filter; unfiltered searches are rejected. Results are capped at 50 per data source by default (`max`).
4. **Read cases, not just hits.** `get_case` lists every published document, but the list alone does not say whether a document has files. Use `with_files: true` to add `fileCount` and `orderOnly` per document (one extra request each), or `get_document` for one document. `orderOnly: true` means nothing is published and the user must send an innsynskrav (offentleglova § 3) to the kommune. Offer draft wording; never send it yourself.
5. **Download** with `download` (a whole case `a-...` or one document `d-...`). Files are named `YYYY-MM-DD_<title> (<DokumentID>).pdf` and existing files are skipped, so it is safe to resume. Order-only documents are listed in the result, not fetched.

## Downloads need Playwright

Search and reading work with Node alone. Downloads need Playwright with a matching Chromium:

- Install globally: `npm i -g playwright && npx playwright install chromium`, or set `ACOS_PLAYWRIGHT_MODULE` to an installed module's path. Restart the MCP server afterwards (in Claude Code: `/reload-plugins` or restart).
- Each Playwright version needs one specific Chromium build. If the environment ships browsers in a fixed `PLAYWRIGHT_BROWSERS_PATH` (common in Docker images), install the Playwright version that matches them instead of the latest.
- If the tool says Playwright is missing or its browser does not match, tell the user the exact fix from the error. Search and metadata still work meanwhile.

## Reporting

- Quote case numbers (saksnummer) and DokumentID so the user can find them in the portal.
- Say which sources and search terms you used, and what found nothing. "No hits" is a finding.
- Absence in Innsyn+ does not prove a case never existed: it may be unpublished, screened, handled by another body (Statsforvalteren is in eInnsyn), or informal.

## Be a good citizen

- Requests are throttled on purpose (`ACOS_INNSYN_DELAY_MS`, default 600 ms; files 2 s). Do not loop over thousands of cases; search narrowly.
- File downloads are behind the portal's Azure WAF JavaScript challenge. The tool opens the file once in headless Chromium (Playwright) so the challenge runs as in any browser, then reuses the cookie. It does not disguise the browser. If the tool reports that the firewall is refusing downloads, stop and wait 10-30 minutes; do not retry in a loop.
- Only public material is reachable. Personal data in the journal is still personal data: use it for the user's own case.
