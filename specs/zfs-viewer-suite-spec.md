# ZFS viewer suite: several graphs, shared nodes and timelines (build spec)

This spec extends the viewer defined in `../zfs-io-flow-diagram-spec.md` (sections 2 to 5 and 12) and built in `../viewer/`. It turns the single I/O flow page into a suite of linked pages, one per content spec in this folder, and adds a second kind of view, the timeline, for flows that are about state over time rather than data moving between components.

Source of truth for content: OpenZFS commit `c913da86156eba3243cc1ef515e98d69887654a7` (2.4.99), as in every content spec.

## 0. Instructions to the building agent

1. Keep the renderer free of ZFS knowledge. Everything specific to a graph comes from its spec.
2. Change the existing viewer in place (`../viewer/src/`, `build_graph.py`, `validate_graph.py`). Every existing behaviour and acceptance check of the I/O spec must keep passing.
3. Follow the build order of the I/O spec (section 12): list new functions with one-line contracts before implementing them.

## 1. Goal

A reader who is looking at one flow (for example a scrub repairing a block) can see that a box is the same code as in another flow (the vdev queue in the I/O graph), jump there, and come back. Flows that are really about which blocks a snapshot or dataset still references are shown as a timeline of states instead of a node graph.

## 2. The suite

| Page | Spec | Views |
|---|---|---|
| `zfs-io-flow.html` | `../zfs-io-flow-diagram-spec.md` | graph |
| `zfs-scrub-resilver.html` | `zfs-scrub-resilver-spec.md` | graph |
| `zfs-send-receive.html` | `zfs-send-receive-spec.md` | graph |
| `zfs-snapshot-lifecycle.html` | `zfs-snapshot-lifecycle-spec.md` | graph and timeline |
| `zfs-fault-management.html` | `zfs-fault-management-spec.md` | graph |
| `zfs-encryption-keys.html` | `zfs-encryption-keys-spec.md` | graph |
| `zfs-pool-create.html` | `zfs-pool-create-spec.md` | graph |
| `zfs-dataset-create.html` | `zfs-dataset-create-spec.md` | graph |
| `zfs-pool-import-export.html` | `zfs-pool-import-export-spec.md` | graph |
| `zfs-destroy.html` | `zfs-destroy-spec.md` | graph |
| `index.html` | this spec | suite landing page |

Each page stays self-contained and works from `file://` with no network access. Pages link to each other with relative links, so the suite works when the `viewer` folder is copied anywhere.

## 3. Build changes

- `build_graph.py` takes a suite manifest, `viewer/suite.json`, listing each page's id, title, spec path and output file name, in the order of the table above. `python3 build_graph.py --suite suite.json` builds every page; the existing single-spec options keep working.
- Each page's graph data gains `suite`: the manifest entries (id, title, file) and, for every node id, the list of other pages that contain a node with the same id. Compute this at build time from all specs in the manifest.
- `build_graph.py` parses an optional `## Appendix E. Timelines` section (grammar in section 6) into `timelines` in the graph data.
- `index.html` is generated from the manifest: one card per page with its title, the first paragraph of its spec, its node, wire and path counts, and a link.
- `validate_graph.py` takes `--suite suite.json` and validates every page. In addition to the existing checks it verifies:
  - every node id that appears in more than one spec has the same title and context in each, and each shared node's role text starts with `Shared with the I/O flow graph.` outside the I/O spec;
  - every wire type id used in more than one spec has the same colour in each;
  - the timeline rules of section 6.4.

## 4. Viewer changes for the suite

1. Top bar: a "Graphs" menu listing the suite pages (current page marked), and a link to `index.html`.
2. Node details: when a node also exists in other pages, show "Also in:" with one link per page to `<file>#node=<id>`. Shared nodes get a small chain-link marker in the title bar, left of the context pill, with the same list as its tooltip.
3. Path details: a path's "Ends" text may name a path in another graph as `` `<page id>:<path id>` ``. Render such a name as a link to `<file>#path=<path id>`.
4. Deep links keep working across pages, so "Also in" opens the other page with that node selected and centred.
5. Storage keys include the page id, so each page keeps its own layout and view.

## 5. Timeline view

Used by pages whose spec has Appendix E (at first only the snapshot lifecycle page).

### 5.1 Layout

- A "Graph | Timeline" switch in the top bar. The left panel lists the timeline scenarios under the heading "Timelines", below the paths.
- A timeline scenario is a sequence of steps. The view shows one step at a time as a panel, with a step strip along the top: one chip per step showing its txg and caption. Transport controls work as for paths (first, previous, next, last, Play; Left, Right, Home, End, Space).
- The panel has one row per dataset (head, snapshot, bookmark or clone) present in that step, in the order given by the step's `DS` lines. Snapshots are drawn as a chain: each snapshot row is labelled with its creation txg and points to its `prev` snapshot.
- Each block is a tile placed in every dataset row that references it (`in=`). Tile fill is a colour scale by birth txg (oldest dark, newest bright), with the birth txg printed on the tile. A block that is on a dataset's deadlist (`dead=`) is drawn in that dataset's deadlist lane, a thinner lane under the dataset row, with the `dead` wire-type colour.
- Block states: `live` normal, `freed` faded with a strike-through and a "freed" label, `deferred` (freed, space not yet reusable) dashed outline, `async` (queued for background destroy) dotted outline.
- Changes since the previous step are highlighted: new tiles get a yellow outline, tiles that changed lane or state slide to their new place (CSS transition) and are outlined.
- A caption under the strip shows the step's caption and notes. When the step names a `path` or `wires`, the caption shows them as links: clicking switches to the graph view with that path active (at the named step if given) or that wire selected. The step's references (from its wires) are shown with their source lines, as in section 4.11 of the I/O spec.

### 5.2 Interaction

- Hovering a tile shows the block id, birth txg, the datasets that reference it, the deadlist it is on and its state.
- Clicking a dataset row label shows that dataset's details in the right panel: kind, creation txg, prev snapshot, the blocks it references and its deadlist at this step.
- Deep link: `#timeline=<scenario id>&step=<n>`.

## 6. Appendix E grammar (timelines)

A content spec may end with:

~~~
## Appendix E. Timelines

### E.1 `<scenario_id>` - <Title>

<Summary paragraph.>

```
STEP 1 txg=100 "<caption>"
  DS fs head
  BLK A birth=90 in=fs
STEP 2 txg=105 "<caption>" path=<path id>[@<step n>] wires=E001,E002
  DS fs head prev=fs@s1
  DS fs@s1 snapshot txg=105
  BLK A birth=90 in=fs,fs@s1
  NOTE "<text>"
```
~~~

### 6.1 Lines

| line | fields |
|---|---|
| `STEP <n> txg=<txg> "<caption>" [path=<path id>[@<step>]] [wires=<id>,<id>]` | Starts step `n` (1, 2, 3 ... in order). `txg` is the txg the step's operation happens in; it never decreases. `path` names a section 10 path of the same spec and optionally a step number; `wires` names wires of the same spec. |
| `DS <name> <kind> [prev=<name>] [txg=<txg>] [origin=<name>]` | A dataset present after this step. `kind` is `head`, `snapshot`, `bookmark` or `clone`. `prev`: the previous snapshot in the chain. `txg`: creation txg (snapshots and bookmarks). `origin`: the snapshot a clone was created from. |
| `BLK <id> birth=<txg> [in=<name>,<name>] [dead=<name>] [state=<state>]` | A block present after this step. `in`: datasets whose tree references it. `dead`: the dataset whose deadlist holds it. `state`: `live` (default), `freed`, `deferred` or `async`. |
| `NOTE "<text>"` | A note shown with the step caption. |

### 6.2 Semantics

- Each step lists the complete state after its operation, not a difference. The renderer computes differences between consecutive steps.
- A block keeps its id for its whole life. A rewritten block gets a new id (for example `B` and then `B2`).
- A block shown as `freed` in one step may be omitted from later steps.
- Block ids, dataset names and txgs are illustrative; the rules they follow (when a block goes to a deadlist instead of being freed, what destroy frees, what rollback discards) must match the code and be backed by `path` or `wires` links to wires whose Appendix C references show that code.

### 6.3 Data model

`timelines`: a list of `{ id, title, summary, steps: [ { n, txg, caption, path, pathStep, wires: [ids], notes: [text], datasets: [ { name, kind, prev, txg, origin } ], blocks: [ { id, birth, in: [names], dead, state } ] } ] }`.

### 6.4 Validation

- Steps are numbered 1..n and txgs never decrease.
- Every `in`, `dead`, `prev` and `origin` name is a dataset listed in the same step.
- `birth` is not greater than the step's txg.
- A `freed`, `deferred` or `async` block has no `in` datasets.
- Every `path` names a path of the same spec (and an existing step number when given); every `wires` id exists.
- Every scenario has at least one step with a `path` or `wires` link.

## 7. Acceptance checklist

- `python3 build_graph.py --suite suite.json` builds every page and `index.html`; `python3 validate_graph.py --suite suite.json` reports 0 failures.
- Every page passes the acceptance checklist of its own spec, and the I/O page still passes every check of `../zfs-io-flow-diagram-spec.md` section 13.
- On the scrub page, node `vdev_queue` shows "Also in: ZFS I/O Flow"; following the link opens the I/O page with `vdev_queue` selected and centred.
- On the snapshot page, the timeline view plays every scenario of Appendix E. Clicking a step's path link switches to the graph view with that path active.
- Every page opens from `file://` with no console errors and no network requests.
