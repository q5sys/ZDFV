# ZFS flow specs: authoring guide

This folder holds the content specs for the ZFS viewer suite. Each spec describes one diagram. The viewer in `../viewer/` renders any spec written to these rules, and `../viewer/validate_graph.py` checks it.

| Spec | Diagram |
|---|---|
| `../zfs-io-flow-diagram-spec.md` | Read and write I/O paths (the first graph; also defines the viewer itself) |
| `zfs-viewer-suite-spec.md` | Viewer changes for several graphs, shared nodes and the timeline view |
| `zfs-scrub-resilver-spec.md` | Scrub, resilver and sequential rebuild |
| `zfs-send-receive-spec.md` | Send and receive (replication) |
| `zfs-snapshot-lifecycle-spec.md` | Snapshots, deadlists, destroy, rollback, bookmarks (graph plus timeline) |
| `zfs-fault-management-spec.md` | I/O error to ereport to zed to degrade, spare and resilver |
| `zfs-encryption-keys-spec.md` | Encryption key hierarchy and key management |
| `zfs-pool-create-spec.md` | Creating a pool: vdev types, labels, the MOS and the first txg |
| `zfs-dataset-create-spec.md` | Creating a dataset or volume and where it sits in the pool |
| `zfs-pool-import-export-spec.md` | Finding, importing and exporting a pool |
| `zfs-destroy-spec.md` | Destroying a snapshot, a dataset (recursively) and a pool |

## 1. Source of truth

Every spec is pinned to OpenZFS commit `c913da86156eba3243cc1ef515e98d69887654a7` (master, 2026-11-13, version 2.4.99). A checkout of that commit is at `../zfs`. Every function name, file, line, tunable, property and behaviour claim must be checked in that checkout. Do not rely on memory of other OpenZFS versions: code moves between releases.

## 2. Writing rules

- Professional, plain technical English. No emojis. No em-dashes or en-dashes (use a comma, colon, parentheses or " - " in titles only).
- Wire labels are plain-language paraphrases that name the real functions, for example `dsl_scan_visitbp() reads the block pointer's children`. They are captions, not code listings.
- A label or role text must be true of the code at the pinned commit. If something is only true in common cases, say so ("normally", "unless ...").
- Prefer fewer, accurate nodes and wires over many vague ones.

## 3. File skeleton

The parsers in `../viewer/build_graph.py` key on these exact headings and table shapes. Copy the shapes from `../zfs-io-flow-diagram-spec.md`, which is the reference example.

~~~
# <Title> (build spec)

<one paragraph: what this diagram is for>

Source of truth: `https://github.com/openzfs/zfs` at commit `c913da86156eba3243cc1ef515e98d69887654a7` (master, 2026-11-13, version 2.4.99). Every function name, file path and tunable in this document was checked against that commit.

## 0. Instructions to the building agent
(short: render with the viewer in ../viewer as extended by specs/zfs-viewer-suite-spec.md; do not change content without verifying it)

## 1. Goal
### Mental model the diagram has to convey
1. ... (numbered list, 4 to 8 points; these go into the About overlay)
### Scope
In scope: ... Out of scope: ...

## 2. Deliverable
(one paragraph: built by ../viewer/build_graph.py --spec <this file>; page name)

## 6. Wire types and contexts
### 6.1 Wire types
| type id | colour | name | what travels on the wire |
### 6.2 Execution contexts
| ctx id | meaning |

## 7. Groups and default layout
| group id | title | colour | first column | band | sub-columns | nodes | summary |
Default layout rules: (copy from the I/O spec; same column pitch and stacking)

## 8. Nodes
<N> nodes. ...
### 8.1 <Group title> (`<group id>`)
| node id | title | sub-col | ctx | primary source file | functions | role |

## 9. Wires
<N> wires. ...
| wire | from | to | type | label | on paths |

## 10. Paths
<N> named paths, <M> steps in total. ...
### 10.1 `<path_id>` - <Title>
Category: <Category>. <Summary sentence(s).>
Alternatives:            (optional)
- `<group>`: `<option>` <label>; `<option>` <label>
```
 1  E001  a -> b
 2  E002  b -> c  [group: option]  "optional note"
```
Ends: <what state the system is in afterwards>

## 11. Accuracy rules and known simplifications
Simplifications made on purpose. ...
1. ...

## 12. Build order
(one line: see ../zfs-io-flow-diagram-spec.md section 12 and specs/zfs-viewer-suite-spec.md)

## 13. Acceptance checklist
- Counts: <n> nodes, <n> wires, <n> paths, <n> path steps, <n> groups, <n> wire types, <n> functions in the index, <n> wire references (Appendix C), <n> tunable and property references (Appendix D).
- Activating path `<id>` with the default alternative highlights <n> distinct wires and plays <n> steps; `<id2>` highlights <n> and plays <n>.
- (other checks specific to this diagram)

## Appendix A. Function index
```
name  path:line
```
## Appendix C. Wire source references
```
E001  path:line  symbol
```
## Appendix D. Tunable and property source references
```
name  path:line  symbol
```
~~~

Notes on the skeleton:

- Section numbers 6 to 13 and the appendix letters must be exactly as shown. Sections 3 to 5 are omitted: the viewer behaviour is defined once, in the I/O spec and the suite spec. Appendix B (zio pipelines) belongs to the I/O spec only; omit it.
- The "Counts:" line and the "highlights ... distinct wires and plays ... steps" line are read by the validator. Keep their wording. Give at least two paths in the highlights line.
- Path step syntax, alternative groups and notes are defined in section 10 of the I/O spec. Every combination of options must play as one connected piece.
- Node `functions` are listed in the node table with backticks; the first is the headline function. Every one of them must appear in Appendix A with its definition line, and Appendix A must contain nothing else.
- Tunables and properties go at the end of the role text as `Tunables: ` and `Properties: ` lists (backticked names), exactly as in the I/O spec. Each one needs an Appendix D line: tunables point at their `ZFS_MODULE_PARAM` line (symbol: the name part as written in that line), properties at their `zprop_register_*()` line in `module/zcommon/zfs_prop.c` (symbol: the quoted name). Pool properties use `module/zcommon/zpool_prop.c`.
- Appendix C needs at least one reference per wire, in the order of the calls in the label. Prefer the exact call site; for callbacks, pipeline decisions and return wires use the line that performs the hand-over. The symbol must appear verbatim on the line and must be a single token (no spaces); the build stops on any reference line it cannot parse.
- Userspace code (`cmd/`, `lib/`) may be referenced. Its context is `user`.

## 4. Size and layout

- Aim for 25 to 60 nodes, 60 to 160 wires and 6 to 15 paths per graph (the encryption graph can be smaller). Every node needs at least one wire and every wire must be on at least one path.
- Groups are laid out left to right by `first column`; a group occupies `sub-columns` columns. Groups must not share columns, except a `top` and a `bottom` group pair, which share the same first column and sub-column count. Keep the flow left to right: initiators on the left, disks or results on the right.
- Keep each sub-column to at most about 9 nodes, so the graph is not much wider than it is tall.

## 5. Shared nodes

Several flows pass through code already modelled in the I/O graph (zio pipeline stages, vdev queue, leaf driver, txg sync, spa_sync, arc_read, dbuf, dmu_tx and so on). When a graph needs one of these:

- reuse the I/O spec's node id verbatim (for example `st_vdev_io_start`, `vdev_queue`, `arc_read`, `spa_sync`, `txg_sync`, `dmu_tx`);
- give it the same title and context as in the I/O spec, and list only the functions this graph needs (they must still be in this spec's Appendix A);
- start its role text with `Shared with the I/O flow graph.` followed by what it does in this flow.

The suite viewer uses identical ids to cross-link the graphs. Do not reuse an I/O id for a node that means something different.

The same applies to every other spec in this folder. Before creating a node, search the existing specs for its headline function (for example `grep -n 'zfs_ioc_destroy' specs/*.md`). If another spec already has a node for that code, reuse its id with exactly the same title and context (the functions listed and the role text may differ). A node shared only with non-I/O specs does not need the `Shared with the I/O flow graph.` marker. Ids already used across several specs include `zfs_cmd` ("zfs(8) command", `user`) and `sync_task` ("dsl_sync_task()", `syscall`).

Every graph whose flows are started by a command has a start node `admin` (title "Administrator", context `user`, functions `-`) as the first node of the command's group, with one `ctl` wire per command line it runs (for example `runs zpool import ...`), referenced to the subcommand's entry in the command table (`cmd/zfs/zfs_main.c` or `cmd/zpool/zpool_main.c`). Each path that a command starts has that wire as step 1. Without it, the command node shows only the results and refusals coming back into it and reads as a sink instead of the start.

To point the reader at a path in another graph, write `` `<page id>:<path id>` `` in a path's summary or "Ends" text; the viewer turns it into a link and the validator checks the target exists. Page ids are the spec file names without `-spec.md` (for example `zfs-snapshot-lifecycle`; the I/O graph is `zfs-io-flow`).

## 6. Wire types

The eleven types of the I/O spec keep their ids and colours in every graph:

| type id | colour | name |
|---|---|---|
| `uio` | `#9BD35A` | User data |
| `dbuf` | `#FFA94D` | DMU buffer |
| `arc` | `#B197FC` | ARC buffer |
| `abd` | `#FF6B6B` | Physical payload |
| `zio` | `#4DABF7` | I/O request |
| `bp` | `#F783AC` | Block pointer |
| `tx` | `#FFD43B` | Transaction |
| `log` | `#3BC9DB` | Intent-log record |
| `alloc` | `#C59F7B` | Space |
| `bio` | `#E9ECEF` | Device I/O |
| `ctl` | `#868E96` | Control (drawn dashed) |

New types are reserved per graph so the suite legend stays consistent. Use only these, and only in the graph listed:

| type id | colour | name | graph |
|---|---|---|---|
| `scan` | `#E599F7` | Scan work (bookmarks, queued scan entries, scan position) | scrub/resilver |
| `dtl` | `#63E6BE` | Dirty time log (txg ranges a device is missing) | scrub/resilver, fault management |
| `stream` | `#C0EB75` | Send stream records | send/receive |
| `dead` | `#8CE99A` | Deadlist and bpobj entries (blocks waiting to be freed) | snapshot lifecycle |
| `event` | `#F76707` | Events (ereports, sysevents, zed actions) | fault management |
| `key` | `#20C997` | Key material (user key, wrapping key, master keys) | encryption |
| `cfg` | `#FFD8A8` | Configuration and properties (pool config and vdev tree nvlists, labels, property nvlists) | pool create, dataset create, import/export, destroy |

A graph lists in its section 6.1 only the types it actually uses, and the validator expects that count.

## 7. Contexts

Reuse the I/O spec's context ids (`user`, `open`, `sync`, `iss`, `int`, `thr`, `any`, `hw`) with the I/O spec's meanings. In particular `open` means "the calling thread, inside a dmu_tx"; do not use it for code that merely runs in a syscall.

Two further contexts are standard across the suite. Copy their meaning text verbatim into a graph's 6.2 table when the graph uses them:

| ctx id | meaning |
|---|---|
| `syscall` | Kernel, in the thread of the calling process (an ioctl on /dev/zfs, mount(2) or umount(2)) or a helper thread it starts, outside syncing context and outside any dmu_tx |
| `zed` | The userspace ZFS event daemon (zed) and its agent thread |

If a graph needs yet another context, add it with a clear meaning and check that no other spec already defines the same idea under a different id.

A node id used in more than one spec must have the same title and context in every spec. Use a different id for a different thing.

## 8. Verification (run before declaring a spec done)

From the project root, with an output directory in your scratch space:

```
python3 viewer/build_graph.py --spec specs/<file>.md --repo zfs --out <scratch dir>
python3 viewer/validate_graph.py --spec specs/<file>.md --graph <scratch dir>/graph.json --repo zfs
```

`build_graph.py` fails on any reference whose line does not contain its symbol. `validate_graph.py` must report 0 failures: it checks counts, connectivity for every option combination, the "on paths" column, step text, Appendix A definitions, Appendix C and D references, and the section 13 numbers.

The mechanical checks do not prove a label is true. Read the code behind every wire you write.
