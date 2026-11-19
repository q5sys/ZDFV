# ZFS flow diagrams viewer

Interactive diagrams of OpenZFS at commit
`c913da86156eba3243cc1ef515e98d69887654a7` (2.4.99). Open `index.html` (or
any page directly) in Firefox or Chromium. Every page works from `file://`
with no network access, and the pages link to each other with relative links,
so the folder can be copied anywhere.

| Page | Spec |
|---|---|
| `zfs-io-flow.html` | `../zfs-io-flow-diagram-spec.md` (also defines the viewer) |
| `zfs-scrub-resilver.html` | `../specs/zfs-scrub-resilver-spec.md` |
| `zfs-send-receive.html` | `../specs/zfs-send-receive-spec.md` |
| `zfs-snapshot-lifecycle.html` | `../specs/zfs-snapshot-lifecycle-spec.md` (graph and timeline views) |
| `zfs-fault-management.html` | `../specs/zfs-fault-management-spec.md` |
| `zfs-encryption-keys.html` | `../specs/zfs-encryption-keys-spec.md` |
| `zfs-pool-create.html` | `../specs/zfs-pool-create-spec.md` |
| `zfs-dataset-create.html` | `../specs/zfs-dataset-create-spec.md` |
| `zfs-pool-import-export.html` | `../specs/zfs-pool-import-export-spec.md` |
| `zfs-destroy.html` | `../specs/zfs-destroy-spec.md` |
| `index.html` | generated from `suite.json` |

All content (nodes, wires, paths, timelines, source references) comes from
the specs; the page code contains no ZFS knowledge. The suite behaviour (graph
menu, "Also in" links between pages, `page:path` links, timeline view) is
specified in `../specs/zfs-viewer-suite-spec.md`. Rules for writing a new spec
are in `../specs/README.md`.

## Files

| File | Purpose |
|---|---|
| `*.html` | The pages. Each is self-contained: styles, script and graph data are inlined. |
| `<page>.json`, `graph.json` | Each page's graph data, for other tools (`graph.json` is the I/O page, as its spec requires). |
| `suite.json` | The suite manifest: page id, title, spec and output file, in menu order. An optional `summary` replaces the spec's first paragraph on the index page. |
| `build_graph.py` | Parses the specs and the OpenZFS checkout; writes the JSON files, the pages and `index.html`. |
| `validate_graph.py` | The checks of the I/O spec section 12 step 2, the timeline rules and the cross-page rules of the suite spec. Run after every build. |
| `src/template.html`, `src/style.css`, `src/app.js`, `src/index.html` | Page sources. `build_graph.py` inlines them. Edit these, not the generated HTML. |

## Regenerate

From this directory, with a checkout of the pinned commit at `../zfs`:

```
python3 build_graph.py --suite suite.json
python3 validate_graph.py --suite suite.json
```

Single-spec mode still works: `python3 build_graph.py --spec <spec> --out <dir>`
writes `graph.json` and the page, and `python3 validate_graph.py --spec <spec>
--graph <dir>/graph.json` checks it. Use it while writing a new spec. Both
scripts accept `--repo` to point at another checkout. The checkout is needed
because the text of every referenced source line is embedded in the pages for
the hover tooltips. `build_graph.py` exits non-zero if a reference points at a
line that does not contain its symbol; `validate_graph.py` exits non-zero on
any failed check and lists each failure.

To add a page: write its spec following `../specs/README.md`, add it to
`suite.json`, rebuild and validate.

Browser storage holds only node positions, collapsed nodes and the view, per
page, under keys `<page id>:<commit>`. Use "Reset layout" to return to the
computed default.

## Deviations

Content: none. No node, wire or path was added, removed, renamed or
re-routed relative to the spec.

Presentation choices made where the spec left room or could not be met
literally:

1. Group titles at low zoom. At fit-all the single-column groups are only
   about 40 to 80 screen pixels wide, too narrow for their titles. When a
   title would render below 12 px, the in-frame title and summary are hidden
   and the titles are drawn in screen space, stacked in rows above their
   frames (below, for a group that sits under another one) with a leader
   line. Fit-all leaves room for these rows.
2. Wire stroke widths are in screen pixels (`vector-effect:
   non-scaling-stroke`), 2 px idle and 3 px highlighted at zoom 1 as the spec
   says, narrowed to 0.7 px idle and 2 px highlighted when zoomed far out.
   Without this, highlighted paths disappear at fit-all.
3. Follow also zooms in to the current step when the view is zoomed out
   below 0.35, because a single step cannot be read at fit-all.
4. Direction on highlighted wires is shown with a moving dash rather than a
   midpoint arrowhead (the spec allows either).
5. The data model has three additions the renderer needs to stay free of ZFS
   knowledge: `meta.pipelineNode` (which node shows the full pipeline table,
   read from Appendix B's text), `stages` (Appendix B's stage-to-node
   table, used to list the pipelines that include a stage node), and `about`
   (the mental-model points and simplifications from sections 1 and 11, for
   the About overlay). `pipelines[].note` keeps the parenthetical remarks
   from Appendix B.
6. Clicking a node or wire while a path is active shows its details with a
   "Back to path" button and keeps the path highlighted; Esc first clears the
   selection, then the path.
7. The step-number badges and the step list use each step's number in the
   full listing, so with alternatives selected the numbers can skip.
8. Free trace defaults to depth 3; "unlimited" reaches most of the graph
   because the graph has cycles.

Suite (`../specs/zfs-viewer-suite-spec.md`):

9. The Graphs menu is a drop-down plus an "All" link to `index.html`; the
   top bar's layout buttons are labelled "Export" and "Import" (tooltips say
   "Export layout" and "Import layout") so the bar fits on one line at
   1280 px.
10. The graph data has two further fields: `page` (id, title, file and the
   spec's first paragraph) and `suite` (the page list and, for each shared
   node id, the other pages that contain it). `suite.json` entries may carry a
   `summary` for the index card; the I/O page uses one because its spec opens
   with instructions to the building agent.
11. Timeline tiles slide to their new place with a FLIP transform animation
   rather than a CSS layout transition, because tiles move between rows.
   Blocks no dataset references (freed, deferred or queued) are shown in a
   "pool" row under the datasets.
12. Each appendix of a spec ends at the next "## Appendix" heading, so specs
   without Appendix B (all but the I/O spec) parse without relying on the
   field counts of later appendices.
