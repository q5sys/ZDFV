# ZFS snapshots, destroy and rollback (build spec)

This diagram shows what happens to a block when a file system that has snapshots stops using it, and what each snapshot operation does with those blocks: why deleting a file frees no space while a snapshot holds it, what destroying a snapshot frees and why the space comes back later, why destroying a large file system is asynchronous, what a rollback throws away, and what a bookmark keeps. It has a node graph (sections 6 to 10) and a timeline view (Appendix E) that plays the same rules as block states over time.

Source of truth: `https://github.com/openzfs/zfs` at commit `c913da86156eba3243cc1ef515e98d69887654a7` (master, 2026-11-13, version 2.4.99). Every function name, file path and tunable in this document was checked against that commit.

## 0. Instructions to the building agent

Render this spec with the viewer in `../viewer/`, as extended by `zfs-viewer-suite-spec.md` (suite page `zfs-snapshot-lifecycle.html`, graph and timeline views). Treat sections 6 to 10 and the appendices as data. Do not add, remove or re-route nodes, wires or timeline steps without verifying the change at the pinned commit.

## 1. Goal

One page that lets a ZFS administrator answer "why does deleting a file not free space when snapshots exist, what does destroying a snapshot free, why is destroy sometimes slow or asynchronous, what does rollback throw away, and what is a bookmark good for?"

### Mental model the diagram has to convey

1. A snapshot is a copy of one block pointer. Taking it copies no data: the snapshot and the head share every block, and the head remembers the snapshot's txg as `ds_prev_snap_txg`.
2. When the head stops using a block (overwrite or delete), one comparison decides its fate. Born after the latest snapshot (birth > `ds_prev_snap_txg`): only the head had it, so it is freed now. Otherwise the latest snapshot still has it, and it goes on the head's deadlist. That is why deleting files frees nothing while snapshots hold them.
3. A dataset's deadlist lists the blocks its previous snapshot references but it does not. It is split into sub-lists by birth txg. Taking a snapshot hands the head's deadlist to the new snapshot and gives the head a new, empty one.
4. Destroying a snapshot frees exactly the blocks on the next dataset's deadlist that were born after the destroyed snapshot's previous snapshot: only the destroyed snapshot had them. Its own deadlist moves to the next dataset. A snapshot's `used` property is this unique space.
5. Destroys give space back in the background. Snapshot destroys and file-system destroys only queue blocks (pool free list, bptree, clone livelist); `dsl_scan_sync()` frees a time-limited slice each txg. The pool property `freeing` shows what is left, and freed space is reusable only TXG_DEFER_SIZE (2) txgs later.
6. Rollback never rewinds blocks in place. The head swaps contents with a temporary clone of the latest snapshot, and that clone, which now holds everything written since the snapshot, is destroyed in the background.
7. A bookmark is a snapshot's guid and creation txg without any blocks. It costs no space, survives its snapshot and can still be the incremental source of `zfs send`.
8. All these operations are sync tasks: they run once in syncing context after the txg's data has been written, and the command returns when that txg is on disk.

### Scope

In scope: `zfs snapshot`, `zfs hold` and `zfs release`, `zfs destroy` of snapshots (also deferred with `-d`) and of file systems and clones, `zfs rollback`, `zfs bookmark` from a snapshot, block kill on overwrite and delete, deadlists, the pool free list, the async-destroy bptree, clone livelists, background freeing, snapshot space accounting.

Out of scope: send and receive (another graph; only referenced), promote, rename, clone creation in detail, redaction bookmarks, bookmark destroy and copy, device-removal remap deadlists, encryption, pre-deadlist pool formats.

## 2. Deliverable

Built by `../viewer/build_graph.py --spec specs/zfs-snapshot-lifecycle-spec.md` into the suite page `zfs-snapshot-lifecycle.html`, with the graph view from sections 6 to 10 and the timeline view from Appendix E.

## 6. Wire types and contexts

### 6.1 Wire types

| type id | colour | name | what travels on the wire |
|---|---|---|---|
| `tx` | `#FFD43B` | Transaction | A sync task joining the open txg, or a txg being synced. |
| `bp` | `#F783AC` | Block pointer | blkptr_t of a block that is killed, queued or freed, or the root block pointer of a destroyed dataset. |
| `dead` | `#8CE99A` | Deadlist and bpobj entries | Blocks waiting to be freed: deadlist sub-lists, the pool free list (dp_free_bpobj), livelist entries. |
| `alloc` | `#C59F7B` | Space | Segments returned to a metaslab. |
| `zio` | `#4DABF7` | I/O request | A ZIO_TYPE_FREE zio in the free pipeline. |
| `ctl` | `#868E96` | Control | Calls that carry no payload: checks, sync-task dispatch, accounting, bookmark bookkeeping. Drawn dashed. |

### 6.2 Execution contexts

| ctx id | meaning |
|---|---|
| `user` | Userspace |
| `open` | Open context: the calling thread, inside a dmu_tx |
| `syscall` | Kernel, in the thread of the calling process (an ioctl on /dev/zfs, mount(2) or umount(2)) or a helper thread it starts, outside syncing context and outside any dmu_tx |
| `sync` | Syncing context: txg_sync thread or dp_sync_taskq workers, one txg at a time |
| `int` | zio interrupt taskq: write completion callbacks |
| `thr` | A dedicated kernel thread or zthr |
| `any` | Runs in whichever context calls it |

## 7. Groups and default layout

| group id | title | colour | first column | band | sub-columns | nodes | summary |
|---|---|---|---|---|---|---|---|
| `cli` | Userspace commands | `#5C5F66` | 0 | full | 1 | 3 | zfs(8), libzfs and libzfs_core build the request and issue one ioctl. |
| `entry` | Kernel entry: ioctl and sync task | `#0C8599` | 1 | full | 1 | 4 | Open context: validate, queue a sync task on the open txg and wait for it to sync. |
| `txg` | TXG sync (shared with the I/O graph) | `#E67700` | 2 | full | 1 | 5 | Where the txg's data is written, blocks are killed and sync tasks run. |
| `ops` | DSL sync tasks | `#1971C2` | 3 | full | 1 | 7 | Snapshot, hold, destroy, rollback and bookmark, each applied once in syncing context. |
| `dead` | Deadlists, bookmarks and space | `#2F9E44` | 4 | full | 2 | 8 | Where killed blocks wait, and the counters that say who owns which space. |
| `bg` | Background freeing | `#862E9C` | 6 | full | 1 | 4 | Frees queued blocks a slice per txg: the free list, the bptree and clone livelists. |
| `free` | Free pipeline (shared with the I/O graph) | `#846358` | 7 | full | 1 | 5 | Returns a block's space to its metaslab, after clone and dedup references are dropped. |

Default layout rules:

- Column pitch is 400 px. A group starts at `first column * 400` and is `sub-columns` columns wide. A node's x is `(group first column + node sub-col) * 400`.
- Inside a sub-column, stack nodes top to bottom in the order they appear in the section 8 tables, 28 px apart. Node height follows its socket count.
- All groups use band `full` and start at the top.
- The layout must be deterministic. Do not run a force-directed or randomised layout in the page.
- Check the default at "fit all": group titles must be readable and no node may overlap another.

## 8. Nodes

36 nodes. `sub-col` is the node's column inside its group. `functions` are real symbols at the pinned commit (locations in Appendix A); the first one is the node's headline function. Nodes whose role starts with "Shared with the I/O flow graph." use the I/O graph's node id, title and context.

### 8.1 Userspace commands (`cli`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `admin` | Administrator | 0 | `user` | - | - | The person or script typing the command. Every path in this graph that a command starts begins with a wire from this node; the arrows that come back into a command node are its results, errors and refusals. |
| `zfs_cmd` | zfs(8) command | 0 | `user` | `cmd/zfs/zfs_main.c` | `zfs_do_snapshot`, `zfs_do_destroy`, `destroy_callback`, `zfs_do_rollback`, `zfs_do_bookmark`, `zfs_do_hold_rele_impl` | The subcommands this graph follows: snapshot (with -r every descendant goes into the same request), destroy (snapshots are batched; -d defers; for a file system its snapshots are destroyed before the file system itself), rollback, bookmark, hold and release. |
| `libzfs` | libzfs / libzfs_core | 0 | `user` | `lib/libzfs_core/libzfs_core.c` | `zfs_snapshot_nvl`, `zfs_destroy_snaps_nvl`, `zfs_destroy`, `zfs_rollback`, `rollback_destroy`, `zfs_hold`, `zfs_hold_nvl`, `zfs_release`, `lzc_snapshot`, `lzc_destroy_snaps`, `lzc_destroy`, `lzc_rollback_to`, `lzc_bookmark`, `lzc_hold`, `lzc_release` | libzfs builds the nvlists; zfs_rollback() first destroys the snapshots and bookmarks newer than the target. libzfs_core turns each request into one ioctl. |

### 8.2 Kernel entry: ioctl and sync task (`entry`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `zfs_ioctl` | ZFS ioctl handlers | 0 | `syscall` | `module/zfs/zfs_ioctl.c` | `zfs_ioc_snapshot`, `zfs_ioc_destroy_snaps`, `zfs_ioc_destroy`, `zfs_ioc_rollback`, `zfs_ioc_bookmark`, `zfs_ioc_hold`, `zfs_ioc_release`, `zfs_unmount_snap` | Kernel entry points. They validate names, unmount snapshots that are about to be destroyed, suspend a mounted file system around a rollback, and call the DSL. |
| `dsl_entry` | DSL request functions | 0 | `syscall` | `module/zfs/dsl_dataset.c` | `dsl_dataset_snapshot`, `dsl_destroy_snapshots_nvl`, `dsl_destroy_snapshot`, `dsl_destroy_head`, `dsl_dataset_rollback`, `dsl_bookmark_create`, `dsl_dataset_user_hold`, `dsl_dataset_user_release`, `dsl_dataset_user_release_impl` | The open-context DSL function behind each ioctl. Each runs its change as a sync task. All snapshots of one request are created in one sync task, all or nothing; dsl_destroy_snapshots_nvl() destroys snapshots one sync task at a time. On pools without async_destroy, dsl_destroy_head() first frees the file system's objects in open context. |
| `sync_task` | dsl_sync_task() | 0 | `syscall` | `module/zfs/dsl_synctask.c` | `dsl_sync_task`, `dsl_sync_task_common`, `dsl_sync_task_sync` | Runs a metadata change in syncing context. The check function runs once in open context as a quick test, the task is queued on the open txg, and the caller waits until that txg has synced. In syncing context dsl_sync_task_sync() checks pool space, re-runs the check with the pool config lock held as writer, and then calls the sync function. |
| `dmu_tx` | dmu_tx (transaction) | 0 | `open` | `module/zfs/dmu_tx.c` | `dmu_tx_create_dd`, `dmu_tx_assign`, `dmu_tx_commit` | Shared with the I/O flow graph. Here a transaction on the MOS directory only pins the sync task to the currently open txg. |

### 8.3 TXG sync (shared with the I/O graph) (`txg`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `txg_sync` | TXG: syncing (txg_sync_thread) | 0 | `thr` | `module/zfs/txg.c` | `txg_sync_thread`, `txg_wait_synced` | Shared with the I/O flow graph. Syncs the txg the sync task joined. txg_wait_synced() is why zfs snapshot, destroy and rollback return only once the change is on disk (the space a destroy frees comes back later). |
| `spa_sync` | spa_sync() | 0 | `sync` | `module/zfs/spa.c` | `spa_sync`, `spa_sync_iterate_to_convergence` | Shared with the I/O flow graph. Each sync pass runs dsl_pool_sync(); after it, dsl_scan_sync() does background frees (in pass 1 only). |
| `dsl_pool_sync` | dsl_pool_sync() | 0 | `sync` | `module/zfs/dsl_pool.c` | `dsl_pool_sync`, `dsl_dataset_sync`, `dsl_dataset_sync_done` | Shared with the I/O flow graph. Writes the dirty datasets first, then (dsl_dataset_sync_done()) applies their space deltas and moves pending deadlist and livelist entries to disk, and only then runs the queued sync tasks. A snapshot taken in txg N therefore contains every write of txg N. |
| `dnode_sync` | dnode_sync() | 0 | `sync` | `module/zfs/dnode_sync.c` | `dnode_sync`, `dnode_sync_free_ranges`, `free_blocks` | Shared with the I/O flow graph. For an object with freed ranges (a removed file is freed as one whole range, also truncate and hole punching), dnode_sync_free_ranges() walks the range and free_blocks() kills every block pointer in it. |
| `dbuf_write_cb` | dbuf_write_ready() / _done() | 0 | `int` | `module/zfs/dbuf.c` | `dbuf_write_done` | Shared with the I/O flow graph. When a block's new copy has been written, dbuf_write_done() retires the copy it replaces: dsl_dataset_block_kill() for the old block pointer, dsl_dataset_block_born() for the new one. Nop-writes and in-place rewrites skip both. |

### 8.4 DSL sync tasks (`ops`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `snap_sync` | Snapshot create | 0 | `sync` | `module/zfs/dsl_dataset.c` | `dsl_dataset_snapshot_sync`, `dsl_dataset_snapshot_check`, `dsl_dataset_snapshot_check_impl`, `dsl_dataset_snapshot_sync_impl` | Creates the snapshot record. The check refuses a second snapshot of the same dataset in one txg (EAGAIN, and the task is retried later), an existing name, and a dataset that is being received into. The sync function points the snapshot at the head's current root block pointer, so a snapshot copies no data. Every snapshot of one request is created in the same txg. |
| `hold_sync` | User holds | 0 | `sync` | `module/zfs/dsl_userhold.c` | `dsl_dataset_user_hold_sync`, `dsl_dataset_user_hold_sync_one_impl`, `dsl_dataset_user_release_check_one`, `dsl_dataset_user_release_sync` | zfs hold adds a named tag to the snapshot's userrefs ZAP and counts it in ds_userrefs. A held snapshot cannot be destroyed; zfs destroy -d marks it instead, and releasing the last hold of a marked snapshot that has no clones and is not in use destroys it in the same sync task (a mounted one is left to the deferred-destroy sweep). Properties: `userrefs`. |
| `destroy_snap` | Snapshot destroy | 0 | `sync` | `module/zfs/dsl_destroy.c` | `dsl_destroy_snapshot_sync_impl`, `dsl_destroy_snapshot_check`, `dsl_destroy_snapshot_check_impl`, `dsl_destroy_snapshot_sync`, `dsl_destroy_snapshot_deferred` | Destroys one snapshot. Refused with EBUSY while user holds exist or the snapshot is in use, and with EEXIST while clones depend on it. With -d it is only marked defer_destroy; a snapshot kept only by its mount is destroyed later by dsl_destroy_snapshot_deferred() on the pool's async thread. Otherwise the next dataset (the following snapshot, or the head) inherits the snapshot's previous-snapshot txg, the deadlists are split and merged, and the record is removed. Properties: `defer_destroy`. |
| `destroy_head` | File system destroy | 0 | `sync` | `module/zfs/dsl_destroy.c` | `dsl_destroy_head_sync_impl`, `dsl_destroy_head_check_impl`, `dsl_destroy_head_sync`, `dsl_async_dataset_destroy`, `dsl_async_clone_destroy`, `old_synchronous_dataset_destroy`, `kill_blkptr` | Destroys a head dataset (file system or volume). Refused with EBUSY while it has snapshots of its own, and with EEXIST while it has child datasets. Its deadlist is discarded and its blocks are handed to one of three mechanisms: the bptree (async_destroy feature), the clone's livelist, or, on old pools, a traversal that kills every block in this txg. |
| `rollback_sync` | Rollback | 0 | `sync` | `module/zfs/dsl_dataset.c` | `dsl_dataset_rollback_sync`, `dsl_dataset_rollback_check`, `dsl_dataset_zero_zil` | Rolls a head back to its latest snapshot. The check requires the named target to be the latest snapshot (EEXIST otherwise), refuses when a bookmark is newer than it, and refuses a snapshot taken in the current txg (EAGAIN). The sync function never rewinds blocks in place: it builds a temporary clone of the snapshot, swaps it with the head, discards the intent log and destroys the clone. |
| `clone_swap` | Temporary clone + clone swap | 0 | `sync` | `module/zfs/dsl_dataset.c` | `dsl_dataset_clone_swap_sync_impl`, `dsl_dataset_create_sync`, `dsl_dataset_create_sync_dd` | dsl_dataset_create_sync() creates the clone %rollback, whose root block pointer is the snapshot's and whose deadlist is empty. dsl_dataset_clone_swap_sync_impl() exchanges the two datasets' contents (root block pointers, deadlists, space counters) and drops both livelists, so the head keeps its name but has the snapshot's tree. The same swap finishes a zfs receive into an existing file system. |
| `bookmark_sync` | Bookmark create | 0 | `sync` | `module/zfs/dsl_bookmark.c` | `dsl_bookmark_create_sync`, `dsl_bookmark_create_check`, `dsl_bookmark_create_sync_impl_snap`, `dsl_bookmark_set_phys` | Creates bookmarks from snapshots (or copies an existing bookmark, not drawn). dsl_bookmark_set_phys() records the snapshot's guid, creation txg and creation time and, with the bookmark_v2 and bookmark_written features, the IV set guid and space counters. A bookmark keeps no block alive. |

### 8.5 Deadlists, bookmarks and space (`dead`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `block_kill` | dsl_dataset_block_kill() | 0 | `any` | `module/zfs/dsl_dataset.c` | `dsl_dataset_block_kill`, `dsl_dataset_block_born` | The rule for a block the head no longer references. Born after the head's latest snapshot (birth > ds_prev_snap_txg): no snapshot can hold it, so it is freed in this txg (gang, dedup and possibly cloned blocks are queued on the pool free list instead). Otherwise the latest snapshot still references it, and it goes on the head's deadlist. dsl_dataset_block_born() does the accounting for the new block. |
| `deadlist` | Deadlist (dsl_deadlist) | 0 | `sync` | `module/zfs/dsl_deadlist.c` | `dsl_deadlist_insert`, `dsl_deadlist_insert_alloc_cb`, `dsl_deadlist_clone`, `dsl_deadlist_add_key`, `dsl_deadlist_remove_key`, `dsl_deadlist_free` | Each dataset has one: the blocks its previous snapshot references but it does not. They died after that snapshot was taken, so they were born at or before it, and that snapshot still holds them. It is a ZAP of sub-lists (each a bpobj) keyed by txg; a block goes into the sub-list with the largest key below its birth txg, so each sub-list holds the blocks born in one interval between snapshots. A new snapshot keeps the head's deadlist, and the head starts a new, empty one. |
| `deadlist_split` | Deadlist split and merge | 0 | `sync` | `module/zfs/dsl_deadlist.c` | `dsl_deadlist_move_bpobj`, `dsl_deadlist_merge`, `dsl_deadlist_insert_bpobj`, `dsl_deadlist_space_range` | Snapshot destroy on the deadlists. In the next dataset's deadlist, the sub-lists keyed at or above the destroyed snapshot's previous-snapshot txg hold blocks that only the destroyed snapshot referenced; they move whole to the pool free list. The other sub-lists stay, and the destroyed snapshot's own deadlist is merged in. dsl_deadlist_space_range() sums a birth range for the accounting. |
| `ds_space` | Space accounting (used, unique, usedbysnapshots) | 0 | `sync` | `module/zfs/dsl_dataset.c` | `dsl_dataset_apply_deltas`, `dsl_dir_diduse_transfer_space`, `dsl_dir_transfer_space`, `dsl_dir_diduse_space`, `dsl_dataset_recalc_head_uniq`, `dsl_get_used` | A snapshot's used is its unique bytes: space that only it references, which destroying it alone would free. Deadlisted blocks are charged to the file system's usedbysnapshots instead of usedbydataset. Deltas collected while blocks are killed are applied once per txg by dsl_dataset_apply_deltas(). Properties: `used`, `referenced`, `usedbydataset`, `usedbysnapshots`. |
| `bookmarks` | Bookmarks (#name) | 1 | `any` | `module/zfs/dsl_bookmark.c` | `dsl_bookmark_node_add`, `dsl_bookmark_snapshotted`, `dsl_bookmark_block_killed`, `dsl_bookmark_sync_done`, `dsl_bookmark_ds_destroyed`, `dsl_bookmark_latest_txg` | The head's bookmarks. A bookmark holds a snapshot's guid and creation txg (optionally a redaction list) but references no blocks, so it costs no space and can be the incremental source of zfs send after its snapshot is gone. With the bookmark_written feature it also counts the space freed since it was taken, for the written#bookmark property, and keeps a deadlist key at its txg. |
| `livelist` | Clone livelist | 1 | `sync` | `module/zfs/dsl_dataset.c` | `dsl_flush_pending_livelist`, `dsl_livelist_should_disable`, `dsl_dir_remove_livelist` | A clone created while the livelist feature is enabled logs every block born after its origin: ALLOC when written, FREE when killed, in sub-lists of about zfs_livelist_max_entries entries. Destroying the clone then frees the unmatched ALLOCs without walking its tree. The livelist is dropped when the clone shares zfs_livelist_min_percent_shared percent or less of its space with the origin, on promote, and on a clone swap. Tunables: `zfs_livelist_max_entries`, `zfs_livelist_min_percent_shared`. |
| `free_bpobj` | Pool free list (dp_free_bpobj) | 1 | `sync` | `module/zfs/bpobj.c` | `bpobj_enqueue`, `bpobj_enqueue_subobj`, `bpobj_iterate`, `bpobj_space` | The pool-wide list of blocks waiting to be freed in the background. A snapshot destroy moves whole deadlist sub-lists here (bpobj_enqueue_subobj(), no per-block work in that txg); block kills park gang, dedup and cloned blocks here. Its space is counted in the freeing pool property. |
| `bptree` | Async-destroy queue (bptree) | 1 | `sync` | `module/zfs/bptree.c` | `bptree_add`, `bptree_alloc`, `bptree_iterate`, `bptree_visit_cb`, `bptree_is_empty` | One entry per destroyed head: its root block pointer, the birth txg at or below which blocks belong to an origin snapshot, and a bookmark to resume the traversal from. Created on first use, which activates the async_destroy feature; freed, and the feature deactivated, when it is empty again. |

### 8.6 Background freeing (`bg`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `bg_scan` | dsl_scan_sync() (free work) | 0 | `sync` | `module/zfs/dsl_scan.c` | `dsl_scan_sync`, `dsl_scan_active` | Called once per txg from spa_sync() and active only in sync pass 1 (and not in the first few txgs after import). Before any scrub or resilver work it calls dsl_process_async_destroys() when dsl_scan_active() reports pending frees. |
| `async_destroy` | dsl_process_async_destroys() | 0 | `sync` | `module/zfs/dsl_scan.c` | `dsl_process_async_destroys`, `bpobj_dsl_scan_free_block_cb`, `dsl_scan_free_block_cb`, `dsl_scan_async_block_should_pause` | Frees queued blocks within a budget per txg: first the pool free list, then the bptree. Each freed block is subtracted from the freeing pool property. It stops for this txg when dsl_scan_async_block_should_pause() says so, so a large destroy is spread over many txgs and space returns gradually. Tunables: `zfs_free_min_time_ms`, `zfs_async_block_max_blocks`, `zfs_max_async_dedup_frees`, `zfs_free_bpobj_enabled`. Properties: `freeing`. |
| `traverse_destroy` | traverse_dataset_destroyed() | 0 | `sync` | `module/zfs/dmu_traverse.c` | `traverse_dataset_destroyed`, `traverse_visitbp` | Walks a destroyed dataset's block tree from its root block pointer, children before parents, and visits only blocks born after the entry's birth txg; an older block belongs to the origin snapshot and is skipped with everything below it. Starts from the bookmark saved in the bptree entry. |
| `livelist_del` | Livelist delete thread | 0 | `thr` | `module/zfs/spa.c` | `spa_livelist_delete_cb`, `dsl_process_sub_livelist`, `delete_blkptr_cb` | The z_livelist_destroy zthr. For each destroyed clone, one sub-list at a time: dsl_process_sub_livelist() cancels FREE entries against their ALLOCs, and a sync task frees the remaining ALLOCs. |

### 8.7 Free pipeline (shared with the I/O graph) (`free`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `frees` | Block frees | 0 | `sync` | `module/zfs/zio.c` | `dsl_free`, `zio_free`, `zio_free_sync` | Shared with the I/O flow graph. dsl_free() -> zio_free(): an ordinary block freed in the syncing txg normally goes straight to metaslab_free(); gang, dedup and possibly cloned blocks (and frees for another txg) wait on spa_free_bplist and become free zios. The background freeing code calls zio_free_sync() directly. |
| `zio_create` | zio create + execute | 0 | `any` | `module/zfs/zio.c` | `zio_nowait`, `zio_wait` | Shared with the I/O flow graph. Builds and starts the ZIO_TYPE_FREE zio for a block that may need a read first (gang header, dedup table, block reference table). |
| `st_free` | FREE stages | 0 | `sync` | `module/zfs/zio.c` | `zio_free_bp_init`, `zio_brt_free`, `zio_ddt_free`, `zio_dva_free` | Shared with the I/O flow graph. A cloned block drops one BRT reference and a dedup block one DDT reference; only when none remain is the space returned to its metaslab. |
| `brt` | Block reference table (BRT) | 0 | `any` | `module/zfs/brt.c` | `brt_maybe_exists`, `brt_entry_decref` | Shared with the I/O flow graph. Extra reference counts for cloned blocks. brt_maybe_exists() is the cheap test that routes a free through the free pipeline; brt_entry_decref() decides whether the space is really released. |
| `metaslab_free` | metaslab_free() | 0 | `sync` | `module/zfs/metaslab.c` | `metaslab_free`, `metaslab_free_dva` | Shared with the I/O flow graph. Records the freed segments. They become allocatable only TXG_DEFER_SIZE (2) txgs later, so the last txgs on disk stay intact. |

## 9. Wires

79 wires. A wire runs from the node that hands something over to the node that receives it. `on paths` lists the section 10 paths that use the wire.

| wire | from | to | type | label | on paths |
|---|---|---|---|---|---|
| E001 | `zfs_cmd` | `libzfs` | `ctl` | zfs snapshot: zfs_do_snapshot() -> zfs_snapshot_nvl() -> lzc_snapshot(); with -r all descendants are in the same nvlist | snapshot_create |
| E002 | `zfs_cmd` | `libzfs` | `ctl` | zfs destroy fs@snap (-d to defer): zfs_do_destroy() -> zfs_destroy_snaps_nvl() -> lzc_destroy_snaps() | destroy_snapshot, holds_defer |
| E003 | `zfs_cmd` | `libzfs` | `ctl` | zfs destroy fs: destroy_callback() first destroys the batched snapshots (destroy_batched()), then zfs_destroy() -> lzc_destroy() | destroy_filesystem |
| E004 | `zfs_cmd` | `libzfs` | `ctl` | zfs rollback: zfs_do_rollback() -> zfs_rollback(), which destroys newer snapshots and bookmarks (rollback_destroy(), only allowed with -r), then lzc_rollback_to() | rollback |
| E005 | `zfs_cmd` | `libzfs` | `ctl` | zfs bookmark fs@snap fs#mark: zfs_do_bookmark() -> lzc_bookmark() | bookmark_create |
| E006 | `zfs_cmd` | `libzfs` | `ctl` | zfs hold tag fs@snap: zfs_hold() -> zfs_hold_nvl() -> lzc_hold() | holds_defer |
| E007 | `zfs_cmd` | `libzfs` | `ctl` | zfs release tag fs@snap: zfs_release() -> lzc_release() | holds_defer |
| E008 | `libzfs` | `zfs_ioctl` | `ctl` | lzc_snapshot(): ZFS_IOC_SNAPSHOT -> zfs_ioc_snapshot() | snapshot_create |
| E009 | `libzfs` | `zfs_ioctl` | `ctl` | lzc_destroy_snaps(): ZFS_IOC_DESTROY_SNAPS -> zfs_ioc_destroy_snaps(), which first unmounts each snapshot (zfs_unmount_snap()) | destroy_snapshot, holds_defer |
| E010 | `libzfs` | `zfs_ioctl` | `ctl` | lzc_destroy(): ZFS_IOC_DESTROY -> zfs_ioc_destroy() | destroy_filesystem |
| E011 | `libzfs` | `zfs_ioctl` | `ctl` | lzc_rollback_to(): ZFS_IOC_ROLLBACK -> zfs_ioc_rollback(), which suspends a mounted file system (zfs_suspend_fs()) around the rollback | rollback |
| E012 | `libzfs` | `zfs_ioctl` | `ctl` | lzc_bookmark(): ZFS_IOC_BOOKMARK -> zfs_ioc_bookmark() | bookmark_create |
| E013 | `libzfs` | `zfs_ioctl` | `ctl` | lzc_hold(): ZFS_IOC_HOLD -> zfs_ioc_hold() | holds_defer |
| E014 | `libzfs` | `zfs_ioctl` | `ctl` | lzc_release(): ZFS_IOC_RELEASE -> zfs_ioc_release() | holds_defer |
| E015 | `zfs_ioctl` | `dsl_entry` | `ctl` | the handler calls its DSL entry point: dsl_dataset_snapshot(), dsl_destroy_snapshots_nvl(), dsl_destroy_head(), dsl_dataset_rollback(), dsl_bookmark_create(), dsl_dataset_user_hold() or dsl_dataset_user_release() | snapshot_create, destroy_snapshot, holds_defer, destroy_filesystem, rollback, bookmark_create |
| E016 | `dsl_entry` | `sync_task` | `ctl` | dsl_sync_task(check, sync, arg): the check function runs first in open context as a quick test | snapshot_create, destroy_snapshot, holds_defer, destroy_filesystem, rollback, bookmark_create |
| E017 | `sync_task` | `dmu_tx` | `tx` | dmu_tx_create_dd() + dmu_tx_assign(): the task joins the open txg and is added to its dp_sync_tasks list; dmu_tx_commit() | snapshot_create, destroy_snapshot, holds_defer, destroy_filesystem, rollback, bookmark_create |
| E018 | `sync_task` | `txg_sync` | `ctl` | txg_wait_synced(): the caller sleeps until that txg is on disk; a task that failed with EAGAIN is retried TXG_DEFER_SIZE txgs later | snapshot_create, destroy_snapshot, holds_defer, destroy_filesystem, rollback, bookmark_create |
| E019 | `txg_sync` | `spa_sync` | `tx` | txg_sync_thread() -> spa_sync(txg) | snapshot_create, overwrite, destroy_snapshot, holds_defer, free_drain, destroy_filesystem, rollback, bookmark_create |
| E020 | `spa_sync` | `dsl_pool_sync` | `tx` | spa_sync_iterate_to_convergence(): dsl_pool_sync() in every pass | snapshot_create, overwrite, destroy_snapshot, holds_defer, destroy_filesystem, rollback, bookmark_create |
| E021 | `dsl_pool_sync` | `snap_sync` | `ctl` | after the txg's dataset blocks are written, dsl_sync_task_sync() re-runs dsl_dataset_snapshot_check() (EAGAIN if the dataset already has a snapshot in this txg), then dsl_dataset_snapshot_sync() runs dsl_dataset_snapshot_sync_impl() for every snapshot of the request | snapshot_create |
| E022 | `dsl_pool_sync` | `hold_sync` | `ctl` | dsl_sync_task_sync() -> dsl_dataset_user_hold_sync() or dsl_dataset_user_release_sync() | holds_defer |
| E023 | `dsl_pool_sync` | `destroy_snap` | `ctl` | dsl_sync_task_sync() -> dsl_destroy_snapshot_sync() | destroy_snapshot, holds_defer |
| E024 | `dsl_pool_sync` | `destroy_head` | `ctl` | dsl_sync_task_sync() -> dsl_destroy_head_sync() | destroy_filesystem |
| E025 | `dsl_pool_sync` | `rollback_sync` | `ctl` | dsl_sync_task_sync() -> dsl_dataset_rollback_sync() | rollback |
| E026 | `dsl_pool_sync` | `bookmark_sync` | `ctl` | dsl_sync_task_sync() -> dsl_bookmark_create_sync() -> dsl_bookmark_create_sync_impl_snap() for each new bookmark | bookmark_create |
| E027 | `snap_sync` | `deadlist` | `dead` | dsl_dataset_snapshot_sync_impl(): the new snapshot takes the head's deadlist object as it is; dsl_deadlist_clone() gives the head a new, empty deadlist with the same keys, and dsl_deadlist_add_key() adds a key at the previous snapshot's txg | snapshot_create |
| E028 | `snap_sync` | `ds_space` | `ctl` | the snapshot copies the head's root block pointer (ds_bp) and referenced bytes, so it shares every block; the head's ds_prev_snap_txg becomes this txg and its unique bytes drop to 0 | snapshot_create |
| E029 | `snap_sync` | `bookmarks` | `ctl` | dsl_bookmark_snapshotted(): deadlist keys for the bookmarks created since the previous snapshot | snapshot_create |
| E030 | `dsl_pool_sync` | `dbuf_write_cb` | `ctl` | dsl_dataset_sync() -> dmu_objset_sync() writes the dataset's dirty blocks (I/O graph path txg_sync); each finished block write calls dbuf_write_done() | overwrite |
| E031 | `dbuf_write_cb` | `block_kill` | `bp` | unless the write was a nop-write or rewrite (ZIO_FLAG_NOPWRITE), dsl_dataset_block_kill(old block pointer, async) then dsl_dataset_block_born(new block pointer) | overwrite |
| E032 | `dsl_pool_sync` | `dnode_sync` | `ctl` | dmu_objset_sync() -> dnode_sync(): dnode_sync_free_ranges() for an object with freed ranges (file removed, truncated, hole punched) | overwrite |
| E033 | `dnode_sync` | `block_kill` | `bp` | free_blocks(): dsl_dataset_block_kill(block pointer, not async) for every block pointer in the freed range | overwrite |
| E034 | `block_kill` | `frees` | `bp` | birth > ds_prev_snap_txg: no snapshot can reference the block, dsl_free() in this txg; the dataset's unique space shrinks | overwrite, destroy_filesystem |
| E035 | `block_kill` | `free_bpobj` | `dead` | born after the latest snapshot but a gang or dedup block (BP_IS_GANG(), BP_GET_DEDUP()) or possibly cloned (brt_maybe_exists()): bpobj_enqueue() on the pool free list to keep heavy free zios out of this txg; counted in freeing (dp_free_dir) | overwrite |
| E036 | `block_kill` | `deadlist` | `dead` | birth <= ds_prev_snap_txg: the latest snapshot still references it. dsl_deadlist_insert() on the head's deadlist; from a write callback (async) it waits on ds_pending_deadlist first | overwrite |
| E037 | `dsl_pool_sync` | `deadlist` | `dead` | dsl_dataset_sync_done(): ds_pending_deadlist entries are inserted into the deadlist (dsl_deadlist_insert_alloc_cb()) | overwrite |
| E038 | `block_kill` | `ds_space` | `ctl` | deltas: a freed block leaves unique and referenced; a deadlisted block leaves referenced, moves from usedbydataset to usedbysnapshots if born after the dataset's origin (ds_snap_xfer_delta), and becomes unique to the latest snapshot if born after the snapshot before it (ds_prev_unique_delta); applied by dsl_dataset_apply_deltas() | overwrite |
| E039 | `block_kill` | `bookmarks` | `ctl` | dsl_bookmark_block_killed(): a block born at or before a bookmark taken since the latest snapshot adds to that bookmark's freed-before-next-snapshot space (BP_GET_BIRTH() <= zbm_creation_txg) | overwrite |
| E040 | `block_kill` | `livelist` | `dead` | clone with an open livelist and birth > dd_origin_txg: bplist_append(dd_pending_frees); dsl_dataset_block_born() puts new blocks on dd_pending_allocs | overwrite |
| E041 | `dsl_pool_sync` | `livelist` | `dead` | dsl_dataset_sync_done() -> dsl_flush_pending_livelist(): the txg's ALLOC and FREE entries are appended to the livelist; dsl_livelist_should_disable() may drop it | overwrite |
| E042 | `frees` | `metaslab_free` | `alloc` | ordinary block: zio_free() for the syncing txg, or the background code, calls zio_free_sync(), which calls metaslab_free() directly, with no zio | overwrite, free_drain, destroy_filesystem, rollback |
| E043 | `frees` | `zio_create` | `zio` | gang, dedup or possibly cloned block: zio_free() queues it on spa_free_bplist (bplist_append()) for spa_sync_frees(); zio_free_sync() then builds a ZIO_TYPE_FREE zio with ZIO_FREE_PIPELINE (zio_create()) | free_drain |
| E044 | `zio_create` | `st_free` | `zio` | ZIO_FREE_PIPELINE | free_drain |
| E045 | `st_free` | `brt` | `bp` | zio_brt_free(): brt_entry_decref(); if other clones still reference the block, stop: the space stays allocated | free_drain |
| E046 | `st_free` | `metaslab_free` | `alloc` | last reference (zio_ddt_free() does the same for dedup): zio_dva_free() -> metaslab_free() | free_drain |
| E047 | `destroy_snap` | `hold_sync` | `ctl` | dsl_destroy_snapshot_check_impl(): user holds (ds_userrefs > 0) make a plain destroy fail with EBUSY; with -d, dsl_destroy_snapshot_sync_impl() only sets DS_FLAG_DEFER_DESTROY while holds, clones or a mount remain | holds_defer |
| E048 | `hold_sync` | `destroy_snap` | `ctl` | dsl_dataset_user_release_sync(): the last hold of a snapshot marked defer_destroy (DS_IS_DEFER_DESTROY(), no clones) is released, so dsl_destroy_snapshot_sync_impl() runs in the same sync task | holds_defer |
| E049 | `destroy_snap` | `bookmarks` | `ctl` | dsl_bookmark_ds_destroyed(): bookmarks between the previous snapshot and this one add the next deadlist's space to their counters; returns whether a bookmark at this snapshot's txg needs the deadlist key | destroy_snapshot |
| E050 | `destroy_snap` | `deadlist_split` | `dead` | next (the following snapshot, or the head) inherits this snapshot's ds_prev_snap_txg; dsl_deadlist_move_bpobj(next's deadlist, mintxg = that txg), then dsl_deadlist_merge(next's deadlist, this snapshot's deadlist) | destroy_snapshot, holds_defer |
| E051 | `deadlist_split` | `free_bpobj` | `dead` | sub-lists keyed at or above mintxg hold blocks born after the previous snapshot that died before next: only this snapshot had them. bpobj_enqueue_subobj() moves them whole to the pool free list; freeing (dp_free_dir) grows | destroy_snapshot, holds_defer |
| E052 | `deadlist_split` | `deadlist` | `dead` | this snapshot's own deadlist (blocks born at or before its previous snapshot, still held by older snapshots) is added to next's deadlist sub-list by sub-list (dsl_deadlist_insert_bpobj()) | destroy_snapshot, holds_defer |
| E053 | `destroy_snap` | `ds_space` | `ctl` | dsl_deadlist_space_range(): usedbysnapshots drops (dsl_dir_diduse_space()) by the space moved to the free list; the previous snapshot's unique (ds_unique_bytes) grows by blocks only it now holds; next's unique grows the same way (ds_unique_bytes) or, for the head, is recomputed (dsl_dataset_recalc_head_uniq()) | destroy_snapshot |
| E054 | `destroy_snap` | `deadlist` | `ctl` | the key at this snapshot's creation txg is removed from clones' deadlists (dsl_dir_remove_clones_key()) and, when next is a snapshot, from the head's (dsl_deadlist_remove_key()), unless a bookmark there needs it | destroy_snapshot |
| E055 | `spa_sync` | `bg_scan` | `tx` | spa_sync_iterate_to_convergence() -> dsl_scan_sync(), which returns at once after sync pass 1 (spa_sync_pass()) | free_drain, destroy_filesystem, rollback |
| E056 | `bg_scan` | `async_destroy` | `ctl` | dsl_scan_active() sees pending frees (free list, bptree, destroyed clones); dsl_process_async_destroys() runs before any scrub work | free_drain, destroy_filesystem, rollback |
| E057 | `free_bpobj` | `async_destroy` | `dead` | bpobj_iterate(dp_free_bpobj, bpobj_dsl_scan_free_block_cb): entries are removed as they are freed | free_drain |
| E058 | `async_destroy` | `frees` | `bp` | dsl_scan_free_block_cb(): zio_free_sync() for each block, and its space is subtracted from freeing (dp_free_dir) | free_drain, destroy_filesystem, rollback |
| E059 | `async_destroy` | `spa_sync` | `ctl` | dsl_scan_async_block_should_pause(), for example past zfs_async_block_max_blocks or zfs_max_async_dedup_frees, past half of zfs_txg_timeout, or past zfs_free_min_time_ms (scn_async_block_min_time_ms) while a txg sync is waiting: ERESTART, the rest waits for the next txg | free_drain |
| E060 | `destroy_head` | `deadlist` | `ctl` | dsl_deadlist_free(): the head's deadlist is dropped without freeing anything; it is empty, or (for a clone, and for the rollback clone) its blocks are still held by the origin snapshot | destroy_filesystem, rollback |
| E061 | `destroy_head` | `bptree` | `bp` | dsl_async_dataset_destroy(): bptree_add(root block pointer, ds_prev_snap_txg) and the dataset's space moves to freeing (dp_free_dir); the first entry activates async_destroy (spa_feature_incr()) | destroy_filesystem, rollback |
| E062 | `destroy_head` | `livelist` | `dead` | clone with an open livelist: dsl_async_clone_destroy() adds the livelist to the pool's deleted-clones ZAP (zap_add_int()), moves its space to freeing (dp_free_dir) and wakes the delete thread (zthr_wakeup()) | destroy_filesystem |
| E063 | `destroy_head` | `block_kill` | `bp` | pool without async_destroy: old_synchronous_dataset_destroy() -> traverse_dataset() -> kill_blkptr() -> dsl_dataset_block_kill() for every block born after ds_prev_snap_txg, all in this txg | destroy_filesystem |
| E064 | `async_destroy` | `bptree` | `ctl` | after the free list: bptree_iterate(dp_bptree_obj, free, dsl_scan_free_block_cb); once the bptree is empty the async_destroy feature is deactivated (spa_feature_decr()) | destroy_filesystem, rollback |
| E065 | `bptree` | `traverse_destroy` | `ctl` | for each entry from bt_begin: traverse_dataset_destroyed(root block pointer, be_birth_txg, saved bookmark) | destroy_filesystem, rollback |
| E066 | `traverse_destroy` | `async_destroy` | `bp` | only blocks born after be_birth_txg (td_min_txg) are visited, children before parents (TRAVERSE_POST); bptree_visit_cb() -> dsl_scan_free_block_cb() | destroy_filesystem, rollback |
| E067 | `traverse_destroy` | `bptree` | `ctl` | on ERESTART bptree_iterate() saves the traversal bookmark in the entry (dmu_write()) and resumes there next txg; a finished entry advances bt_begin | destroy_filesystem |
| E068 | `livelist` | `livelist_del` | `dead` | spa_livelist_delete_cb() on the z_livelist_destroy zthr: dsl_process_sub_livelist() keeps the ALLOC entries of one sub-list that have no matching FREE | destroy_filesystem |
| E069 | `livelist_del` | `frees` | `bp` | a sync task (dsl_sync_task(), sublist_delete_sync()) runs delete_blkptr_cb() -> zio_free() for each, subtracting it from freeing | destroy_filesystem |
| E070 | `rollback_sync` | `clone_swap` | `ctl` | dsl_dataset_create_sync(%rollback, latest snapshot): a temporary clone whose root block pointer (ds_bp) is the snapshot's | rollback |
| E071 | `clone_swap` | `ds_space` | `ctl` | dsl_dataset_clone_swap_sync_impl(): head and clone swap root block pointers (ds_bp), deadlists (ds_deadlist_obj) and space counters (ds_unique_bytes); the head now holds the snapshot's tree with an empty deadlist | rollback |
| E072 | `rollback_sync` | `destroy_head` | `ctl` | dsl_dataset_zero_zil() discards the head's intent log, then dsl_destroy_head_sync_impl(%rollback clone) destroys the old contents the clone now holds | rollback |
| E073 | `rollback_sync` | `bookmarks` | `ctl` | dsl_dataset_rollback_check(): EEXIST if a bookmark is newer than the latest snapshot (dsl_bookmark_latest_txg()) | rollback |
| E074 | `bookmark_sync` | `bookmarks` | `ctl` | dsl_bookmark_set_phys() copies the snapshot's guid (zbm_guid) and creation txg (zbm_creation_txg); dsl_bookmark_node_add() stores the bookmark in the head's bookmark ZAP | bookmark_create |
| E075 | `admin` | `zfs_cmd` | `ctl` | runs zfs snapshot [-r] fs@snap | snapshot_create |
| E076 | `admin` | `zfs_cmd` | `ctl` | runs zfs destroy [-d] fs@snap, or zfs destroy fs | destroy_snapshot, destroy_filesystem |
| E077 | `admin` | `zfs_cmd` | `ctl` | runs zfs hold tag fs@snap (and later zfs release) | holds_defer |
| E078 | `admin` | `zfs_cmd` | `ctl` | runs zfs rollback [-r] fs@snap | rollback |
| E079 | `admin` | `zfs_cmd` | `ctl` | runs zfs bookmark fs@snap fs#mark | bookmark_create |

## 10. Paths

8 named paths, 145 steps in total. Each step is one wire; the caption for a step is that wire's label. Every wire in section 9 is on at least one path. Path syntax and alternatives are as in section 10 of `../zfs-io-flow-diagram-spec.md`.

### 10.1 `snapshot_create` - Take a snapshot

Category: Snapshot. zfs snapshot from the command line to the sync task that creates the snapshot record. No data is copied: the snapshot shares the head's root block pointer, takes over the head's deadlist, and moves the head's ds_prev_snap_txg forward.

```
 1  E075  admin -> zfs_cmd
 2  E001  zfs_cmd -> libzfs
 3  E008  libzfs -> zfs_ioctl
 4  E015  zfs_ioctl -> dsl_entry
 5  E016  dsl_entry -> sync_task
 6  E017  sync_task -> dmu_tx
 7  E018  sync_task -> txg_sync
 8  E019  txg_sync -> spa_sync
 9  E020  spa_sync -> dsl_pool_sync
10  E021  dsl_pool_sync -> snap_sync
11  E027  snap_sync -> deadlist
12  E028  snap_sync -> ds_space
13  E029  snap_sync -> bookmarks
```
Ends: The snapshot exists and the command returns. From the next txg on, every block the head kills is compared against the new ds_prev_snap_txg (path overwrite).

### 10.2 `overwrite` - Overwrite or delete: free now or deadlist

Category: Space. What happens to the block the head stops referencing, when copy-on-write replaces it or a file is removed. The comparison birth > ds_prev_snap_txg in dsl_dataset_block_kill() decides between freeing it and keeping it for a snapshot.

Alternatives:
- `cause`: `overwrite` Block overwritten (its new copy has been written); `delete` File removed or truncated (freed range)
- `birth`: `after_snap` Born after the latest snapshot; `before_snap` Born at or before the latest snapshot; `after_special` Born after the latest snapshot, but a gang, dedup or cloned block
- `owner`: `plain` Ordinary file system (no extra steps); `clone` Clone with a livelist

```
 1  E019  txg_sync -> spa_sync
 2  E020  spa_sync -> dsl_pool_sync
 3  E030  dsl_pool_sync -> dbuf_write_cb  [cause: overwrite]
 4  E031  dbuf_write_cb -> block_kill  [cause: overwrite]
 5  E032  dsl_pool_sync -> dnode_sync  [cause: delete]
 6  E033  dnode_sync -> block_kill  [cause: delete]
 7  E034  block_kill -> frees  [birth: after_snap]
 8  E042  frees -> metaslab_free  [birth: after_snap]  "space reusable TXG_DEFER_SIZE txgs later"
 9  E035  block_kill -> free_bpobj  [birth: after_special]  "freed by the background thread (path free_drain)"
10  E036  block_kill -> deadlist  [birth: before_snap]  "nothing is freed: the snapshot keeps the block"
11  E037  dsl_pool_sync -> deadlist  [cause: overwrite]  [birth: before_snap]
12  E038  block_kill -> ds_space
13  E039  block_kill -> bookmarks
14  E040  block_kill -> livelist  [owner: clone]  "only for blocks born after the clone's origin"
15  E041  dsl_pool_sync -> livelist  [owner: clone]
```
Ends: The block is free (reusable two txgs later), queued on the pool free list, or on the head's deadlist where it stays until the snapshots that hold it are destroyed (path destroy_snapshot).

### 10.3 `destroy_snapshot` - Destroy a snapshot

Category: Destroy. zfs destroy fs@snap. Next is the following snapshot, or the head if this is the newest snapshot. Next's deadlist is split at the destroyed snapshot's previous-snapshot txg: the newer part (blocks only this snapshot had) goes to the pool free list, the older part stays and receives this snapshot's own deadlist. For the oldest snapshot that txg is the pool origin's (1, or 0 on very old pools), older than any block, so everything on next's deadlist is freed.

```
 1  E076  admin -> zfs_cmd
 2  E002  zfs_cmd -> libzfs
 3  E009  libzfs -> zfs_ioctl
 4  E015  zfs_ioctl -> dsl_entry
 5  E016  dsl_entry -> sync_task
 6  E017  sync_task -> dmu_tx
 7  E018  sync_task -> txg_sync
 8  E019  txg_sync -> spa_sync
 9  E020  spa_sync -> dsl_pool_sync
10  E023  dsl_pool_sync -> destroy_snap
11  E049  destroy_snap -> bookmarks
12  E050  destroy_snap -> deadlist_split
13  E051  deadlist_split -> free_bpobj  "oldest snapshot: mintxg is older than any block, the whole deadlist goes"
14  E052  deadlist_split -> deadlist
15  E053  destroy_snap -> ds_space
16  E054  destroy_snap -> deadlist
```
Ends: The snapshot is gone and the command has returned, but its unique blocks are only queued on the pool free list; path free_drain frees them over the next txgs.

### 10.4 `holds_defer` - Hold, deferred destroy and release

Category: Destroy. zfs hold keeps a snapshot; zfs destroy -d then only marks it, and the final zfs release destroys it in the same sync task.

```
 1  E077  admin -> zfs_cmd
 2  E006  zfs_cmd -> libzfs  "zfs hold keep fs@s1"
 3  E013  libzfs -> zfs_ioctl
 4  E015  zfs_ioctl -> dsl_entry
 5  E016  dsl_entry -> sync_task
 6  E017  sync_task -> dmu_tx
 7  E018  sync_task -> txg_sync
 8  E019  txg_sync -> spa_sync
 9  E020  spa_sync -> dsl_pool_sync
10  E022  dsl_pool_sync -> hold_sync  "tag added, ds_userrefs is 1"
11  E002  zfs_cmd -> libzfs  "zfs destroy -d fs@s1"
12  E009  libzfs -> zfs_ioctl
13  E015  zfs_ioctl -> dsl_entry
14  E016  dsl_entry -> sync_task
15  E018  sync_task -> txg_sync
16  E019  txg_sync -> spa_sync
17  E020  spa_sync -> dsl_pool_sync
18  E023  dsl_pool_sync -> destroy_snap
19  E047  destroy_snap -> hold_sync  "only marked: defer_destroy=on, nothing freed"
20  E007  zfs_cmd -> libzfs  "zfs release keep fs@s1"
21  E014  libzfs -> zfs_ioctl
22  E015  zfs_ioctl -> dsl_entry
23  E016  dsl_entry -> sync_task
24  E018  sync_task -> txg_sync
25  E019  txg_sync -> spa_sync
26  E020  spa_sync -> dsl_pool_sync
27  E022  dsl_pool_sync -> hold_sync  "last hold released"
28  E048  hold_sync -> destroy_snap
29  E050  destroy_snap -> deadlist_split
30  E051  deadlist_split -> free_bpobj
31  E052  deadlist_split -> deadlist
```
Ends: The snapshot is destroyed as in path destroy_snapshot; its unique blocks wait on the pool free list (path free_drain).

### 10.5 `free_drain` - Background freeing of the pool free list

Category: Free. Every txg, in sync pass 1, dsl_scan_sync() frees blocks from dp_free_bpobj until its time or block budget runs out. This is where the space of destroyed snapshots and of parked gang, dedup and cloned blocks comes back.

Alternatives:
- `kind`: `plain` Ordinary block; `special` Gang, dedup or cloned block (free zio)

```
 1  E019  txg_sync -> spa_sync
 2  E055  spa_sync -> bg_scan
 3  E056  bg_scan -> async_destroy
 4  E057  free_bpobj -> async_destroy
 5  E058  async_destroy -> frees
 6  E042  frees -> metaslab_free  [kind: plain]
 7  E043  frees -> zio_create  [kind: special]
 8  E044  zio_create -> st_free  [kind: special]
 9  E045  st_free -> brt  [kind: special]  "a clone still references it: nothing is freed"
10  E046  st_free -> metaslab_free  [kind: special]
11  E059  async_destroy -> spa_sync  "budget used up: continue next txg"
```
Ends: The freeing pool property drops as blocks are freed; each freed segment is allocatable TXG_DEFER_SIZE txgs after the txg that freed it.

### 10.6 `destroy_filesystem` - Destroy a file system

Category: Destroy. zfs destroy fs, after its snapshots are gone. The destroy itself takes one sync task; the blocks are freed afterwards, a slice per txg.

Alternatives:
- `method`: `bptree` async_destroy feature enabled (normal); `livelist` The file system is a clone with a livelist; `sync` Old pool without async_destroy

```
 1  E076  admin -> zfs_cmd
 2  E003  zfs_cmd -> libzfs
 3  E010  libzfs -> zfs_ioctl
 4  E015  zfs_ioctl -> dsl_entry
 5  E016  dsl_entry -> sync_task
 6  E017  sync_task -> dmu_tx
 7  E018  sync_task -> txg_sync
 8  E019  txg_sync -> spa_sync
 9  E020  spa_sync -> dsl_pool_sync
10  E024  dsl_pool_sync -> destroy_head
11  E060  destroy_head -> deadlist
12  E061  destroy_head -> bptree  [method: bptree]
13  E062  destroy_head -> livelist  [method: livelist]
14  E063  destroy_head -> block_kill  [method: sync]
15  E034  block_kill -> frees  [method: sync]  "every block is freed in this one txg"
16  E055  spa_sync -> bg_scan  [method: bptree]  "next txgs"
17  E056  bg_scan -> async_destroy  [method: bptree]
18  E064  async_destroy -> bptree  [method: bptree]
19  E065  bptree -> traverse_destroy  [method: bptree]
20  E066  traverse_destroy -> async_destroy  [method: bptree]
21  E058  async_destroy -> frees  [method: bptree]
22  E067  traverse_destroy -> bptree  [method: bptree]
23  E068  livelist -> livelist_del  [method: livelist]
24  E069  livelist_del -> frees  [method: livelist]
25  E042  frees -> metaslab_free
```
Ends: The dataset is gone after one txg; its space returns gradually while freeing counts down. Gang, dedup and cloned blocks take the free zio route of path free_drain.

### 10.7 `rollback` - Roll back to the latest snapshot

Category: Rollback. zfs rollback fs@snap. The head swaps contents with a temporary clone of the snapshot; destroying that clone discards every block born after the snapshot, in the background.

```
 1  E078  admin -> zfs_cmd
 2  E004  zfs_cmd -> libzfs
 3  E011  libzfs -> zfs_ioctl
 4  E015  zfs_ioctl -> dsl_entry
 5  E016  dsl_entry -> sync_task
 6  E017  sync_task -> dmu_tx
 7  E018  sync_task -> txg_sync
 8  E019  txg_sync -> spa_sync
 9  E020  spa_sync -> dsl_pool_sync
10  E025  dsl_pool_sync -> rollback_sync
11  E073  rollback_sync -> bookmarks
12  E070  rollback_sync -> clone_swap
13  E071  clone_swap -> ds_space
14  E072  rollback_sync -> destroy_head
15  E060  destroy_head -> deadlist  "the old head's deadlist: its blocks are still in the snapshot"
16  E061  destroy_head -> bptree  "only blocks born after the snapshot will be freed"
17  E055  spa_sync -> bg_scan  "next txgs"
18  E056  bg_scan -> async_destroy
19  E064  async_destroy -> bptree
20  E065  bptree -> traverse_destroy
21  E066  traverse_destroy -> async_destroy
22  E058  async_destroy -> frees
23  E042  frees -> metaslab_free
```
Ends: The file system shows the snapshot's contents as soon as the command returns; the discarded blocks come back over the next txgs. On a pool without async_destroy the clone is destroyed as in the sync option of path destroy_filesystem.

### 10.8 `bookmark_create` - Create a bookmark

Category: Bookmark. zfs bookmark fs@snap fs#mark records the snapshot's identity without keeping any blocks.

```
 1  E079  admin -> zfs_cmd
 2  E005  zfs_cmd -> libzfs
 3  E012  libzfs -> zfs_ioctl
 4  E015  zfs_ioctl -> dsl_entry
 5  E016  dsl_entry -> sync_task
 6  E017  sync_task -> dmu_tx
 7  E018  sync_task -> txg_sync
 8  E019  txg_sync -> spa_sync
 9  E020  spa_sync -> dsl_pool_sync
10  E026  dsl_pool_sync -> bookmark_sync
11  E074  bookmark_sync -> bookmarks
```
Ends: The bookmark exists. Destroying its snapshot frees the snapshot's blocks as usual (path destroy_snapshot); the bookmark keeps the guid and txg, which is all an incremental zfs send -i fs#mark needs as its source (see `zfs-send-receive:incr_send`).

## 11. Accuracy rules and known simplifications

Rules:

- Check everything against a checkout of the pinned commit (`../zfs`). The comparisons that the timeline view relies on are `BP_GET_BIRTH(bp) > dsl_dataset_phys(ds)->ds_prev_snap_txg` in `dsl_dataset_block_kill()` (dsl_dataset.c:304) and `dsl_deadlist_move_bpobj(&ds_next->ds_deadlist, &dp->dp_free_bpobj, dsl_dataset_phys(ds)->ds_prev_snap_txg, tx)` in `dsl_destroy_snapshot_sync_impl()` (dsl_destroy.c:424), with the sub-list choice of `dsl_deadlist_insert()` (dsl_deadlist.c:461).
- Node ids shared with the I/O graph keep that graph's title and context.

Simplifications made on purpose. State these in the page's About overlay so nobody mistakes the diagram for the whole truth:

1. Old on-disk formats are not drawn: pre-deadlist pools (process_old_deadlist()) are left out, and pools without async_destroy appear only as the sync option of path destroy_filesystem.
2. Remap deadlists and obsolete counts (device removal) are left out, although the snapshot, destroy and block-kill code also maintains them.
3. Recursive commands are drawn for one dataset. zfs snapshot -r is still one sync task; zfs destroy -r issues one request per batch of snapshots and one per file system.
4. Promote, rename, clone creation and bookmark copy and destroy are not drawn. Clones appear only through their livelist and the rollback clone.
5. Space accounting is one node. Refreservation, quotas and the roll-up into parent directories are omitted.
6. The intent log of a destroyed dataset (zil_destroy_sync()) and intent-log blocks found by the old synchronous destroy are not drawn.
7. dsl_scan_sync() also runs scrubs and resilvers, and dsl_process_async_destroys() also processes the obsolete bpobj; only the free work is drawn.
8. The deadlist key bookkeeping for bookmarks and clones is summarised in two wires (E029, E054).

## 12. Build order

See `../zfs-io-flow-diagram-spec.md` section 12 and `zfs-viewer-suite-spec.md` (suite build and timeline view).

## 13. Acceptance checklist

- Counts: 36 nodes, 79 wires, 8 paths, 145 path steps, 7 groups, 6 wire types, 145 functions in the index, 200 wire references (Appendix C), 13 tunable and property references (Appendix D).
- Activating path `snapshot_create` highlights 13 distinct wires and plays 13 steps; `destroy_snapshot` highlights 16 and plays 16; `overwrite` with the default alternatives highlights 8 and plays 8.
- Node `block_kill` lists 3 incoming and 6 outgoing wires.
- Choosing `birth: before_snap` in path `overwrite` swaps the free wires for the deadlist wires; choosing `method: sync` in `destroy_filesystem` shows the whole destroy in one txg.
- Node `frees`, `st_free`, `metaslab_free`, `brt`, `dsl_pool_sync`, `spa_sync`, `txg_sync`, `dmu_tx`, `dnode_sync`, `dbuf_write_cb` and `zio_create` show "Also in: ZFS I/O Flow".
- The timeline view plays all scenarios of Appendix E; each step's path or wire link opens the graph with that path or wire selected.

## Appendix A. Function index

145 functions named in section 8, with file and line at commit `c913da8615`.

```
bpobj_dsl_scan_free_block_cb  module/zfs/dsl_scan.c:3840
bpobj_enqueue  module/zfs/bpobj.c:862
bpobj_enqueue_subobj  module/zfs/bpobj.c:663
bpobj_iterate  module/zfs/bpobj.c:534
bpobj_space  module/zfs/bpobj.c:961
bptree_add  module/zfs/bptree.c:110
bptree_alloc  module/zfs/bptree.c:51
bptree_is_empty  module/zfs/bptree.c:96
bptree_iterate  module/zfs/bptree.c:180
bptree_visit_cb  module/zfs/bptree.c:143
brt_entry_decref  module/zfs/brt.c:1077
brt_maybe_exists  module/zfs/brt.c:905
dbuf_write_done  module/zfs/dbuf.c:5213
delete_blkptr_cb  module/zfs/spa.c:3308
destroy_callback  cmd/zfs/zfs_main.c:1483
dmu_tx_assign  module/zfs/dmu_tx.c:1239
dmu_tx_commit  module/zfs/dmu_tx.c:1454
dmu_tx_create_dd  module/zfs/dmu_tx.c:58
dnode_sync  module/zfs/dnode_sync.c:685
dnode_sync_free_ranges  module/zfs/dnode_sync.c:647
dsl_async_clone_destroy  module/zfs/dsl_destroy.c:956
dsl_async_dataset_destroy  module/zfs/dsl_destroy.c:1015
dsl_bookmark_block_killed  module/zfs/dsl_bookmark.c:1500
dsl_bookmark_create  module/zfs/dsl_bookmark.c:626
dsl_bookmark_create_check  module/zfs/dsl_bookmark.c:287
dsl_bookmark_create_sync  module/zfs/dsl_bookmark.c:597
dsl_bookmark_create_sync_impl_snap  module/zfs/dsl_bookmark.c:437
dsl_bookmark_ds_destroyed  module/zfs/dsl_bookmark.c:1301
dsl_bookmark_latest_txg  module/zfs/dsl_bookmark.c:1583
dsl_bookmark_node_add  module/zfs/dsl_bookmark.c:389
dsl_bookmark_set_phys  module/zfs/dsl_bookmark.c:341
dsl_bookmark_snapshotted  module/zfs/dsl_bookmark.c:1403
dsl_bookmark_sync_done  module/zfs/dsl_bookmark.c:1540
dsl_dataset_apply_deltas  module/zfs/dsl_dataset.c:2330
dsl_dataset_block_born  module/zfs/dsl_dataset.c:155
dsl_dataset_block_kill  module/zfs/dsl_dataset.c:264
dsl_dataset_clone_swap_sync_impl  module/zfs/dsl_dataset.c:4338
dsl_dataset_create_sync  module/zfs/dsl_dataset.c:1326
dsl_dataset_create_sync_dd  module/zfs/dsl_dataset.c:1188
dsl_dataset_recalc_head_uniq  module/zfs/dsl_dataset.c:1408
dsl_dataset_rollback  module/zfs/dsl_dataset.c:3469
dsl_dataset_rollback_check  module/zfs/dsl_dataset.c:3300
dsl_dataset_rollback_sync  module/zfs/dsl_dataset.c:3428
dsl_dataset_snapshot  module/zfs/dsl_dataset.c:1956
dsl_dataset_snapshot_check  module/zfs/dsl_dataset.c:1593
dsl_dataset_snapshot_check_impl  module/zfs/dsl_dataset.c:1534
dsl_dataset_snapshot_sync  module/zfs/dsl_dataset.c:1917
dsl_dataset_snapshot_sync_impl  module/zfs/dsl_dataset.c:1736
dsl_dataset_sync  module/zfs/dsl_dataset.c:2133
dsl_dataset_sync_done  module/zfs/dsl_dataset.c:2391
dsl_dataset_user_hold  module/zfs/dsl_userhold.c:317
dsl_dataset_user_hold_sync  module/zfs/dsl_userhold.c:265
dsl_dataset_user_hold_sync_one_impl  module/zfs/dsl_userhold.c:146
dsl_dataset_user_release  module/zfs/dsl_userhold.c:644
dsl_dataset_user_release_check_one  module/zfs/dsl_userhold.c:361
dsl_dataset_user_release_impl  module/zfs/dsl_userhold.c:572
dsl_dataset_user_release_sync  module/zfs/dsl_userhold.c:522
dsl_dataset_zero_zil  module/zfs/dsl_dataset.c:1305
dsl_deadlist_add_key  module/zfs/dsl_deadlist.c:523
dsl_deadlist_clone  module/zfs/dsl_deadlist.c:708
dsl_deadlist_free  module/zfs/dsl_deadlist.c:385
dsl_deadlist_insert  module/zfs/dsl_deadlist.c:461
dsl_deadlist_insert_alloc_cb  module/zfs/dsl_deadlist.c:503
dsl_deadlist_insert_bpobj  module/zfs/dsl_deadlist.c:803
dsl_deadlist_merge  module/zfs/dsl_deadlist.c:867
dsl_deadlist_move_bpobj  module/zfs/dsl_deadlist.c:931
dsl_deadlist_remove_key  module/zfs/dsl_deadlist.c:550
dsl_deadlist_space_range  module/zfs/dsl_deadlist.c:764
dsl_destroy_head  module/zfs/dsl_destroy.c:1264
dsl_destroy_head_check_impl  module/zfs/dsl_destroy.c:819
dsl_destroy_head_sync  module/zfs/dsl_destroy.c:1234
dsl_destroy_head_sync_impl  module/zfs/dsl_destroy.c:1064
dsl_destroy_snapshot  module/zfs/dsl_destroy.c:645
dsl_destroy_snapshot_check  module/zfs/dsl_destroy.c:91
dsl_destroy_snapshot_check_impl  module/zfs/dsl_destroy.c:45
dsl_destroy_snapshot_deferred  module/zfs/dsl_destroy.c:749
dsl_destroy_snapshot_sync  module/zfs/dsl_destroy.c:579
dsl_destroy_snapshot_sync_impl  module/zfs/dsl_destroy.c:307
dsl_destroy_snapshots_nvl  module/zfs/dsl_destroy.c:611
dsl_dir_diduse_space  module/zfs/dsl_dir.c:1622
dsl_dir_diduse_transfer_space  module/zfs/dsl_dir.c:1704
dsl_dir_remove_livelist  module/zfs/dsl_dir.c:2384
dsl_dir_transfer_space  module/zfs/dsl_dir.c:1630
dsl_flush_pending_livelist  module/zfs/dsl_dataset.c:2263
dsl_free  module/zfs/dsl_scan.c:1578
dsl_get_used  module/zfs/dsl_dataset.c:2666
dsl_livelist_should_disable  module/zfs/dsl_dataset.c:2170
dsl_pool_sync  module/zfs/dsl_pool.c:700
dsl_process_async_destroys  module/zfs/dsl_scan.c:3972
dsl_process_sub_livelist  module/zfs/dsl_deadlist.c:1089
dsl_scan_active  module/zfs/dsl_scan.c:3866
dsl_scan_async_block_should_pause  module/zfs/dsl_scan.c:3712
dsl_scan_free_block_cb  module/zfs/dsl_scan.c:3751
dsl_scan_sync  module/zfs/dsl_scan.c:4514
dsl_sync_task  module/zfs/dsl_synctask.c:126
dsl_sync_task_common  module/zfs/dsl_synctask.c:34
dsl_sync_task_sync  module/zfs/dsl_synctask.c:207
free_blocks  module/zfs/dnode_sync.c:125
kill_blkptr  module/zfs/dsl_destroy.c:761
lzc_bookmark  lib/libzfs_core/libzfs_core.c:1519
lzc_destroy  lib/libzfs_core/libzfs_core.c:375
lzc_destroy_snaps  lib/libzfs_core/libzfs_core.c:452
lzc_hold  lib/libzfs_core/libzfs_core.c:578
lzc_release  lib/libzfs_core/libzfs_core.c:625
lzc_rollback_to  lib/libzfs_core/libzfs_core.c:1489
lzc_snapshot  lib/libzfs_core/libzfs_core.c:400
metaslab_free  module/zfs/metaslab.c:6216
metaslab_free_dva  module/zfs/metaslab.c:5915
old_synchronous_dataset_destroy  module/zfs/dsl_destroy.c:790
rollback_destroy  lib/libzfs/libzfs_dataset.c:4295
spa_livelist_delete_cb  module/zfs/spa.c:3396
spa_sync  module/zfs/spa.c:11405
spa_sync_iterate_to_convergence  module/zfs/spa.c:11192
traverse_dataset_destroyed  module/zfs/dmu_traverse.c:748
traverse_visitbp  module/zfs/dmu_traverse.c:226
txg_sync_thread  module/zfs/txg.c:510
txg_wait_synced  module/zfs/txg.c:764
zfs_destroy  lib/libzfs/libzfs_dataset.c:3808
zfs_destroy_snaps_nvl  lib/libzfs/libzfs_dataset.c:3900
zfs_do_bookmark  cmd/zfs/zfs_main.c:8282
zfs_do_destroy  cmd/zfs/zfs_main.c:1698
zfs_do_hold_rele_impl  cmd/zfs/zfs_main.c:6665
zfs_do_rollback  cmd/zfs/zfs_main.c:4411
zfs_do_snapshot  cmd/zfs/zfs_main.c:4647
zfs_hold  lib/libzfs/libzfs_dataset.c:4932
zfs_hold_nvl  lib/libzfs/libzfs_dataset.c:4963
zfs_ioc_bookmark  module/zfs/zfs_ioctl.c:4455
zfs_ioc_destroy  module/zfs/zfs_ioctl.c:4701
zfs_ioc_destroy_snaps  module/zfs/zfs_ioctl.c:4403
zfs_ioc_hold  module/zfs/zfs_ioctl.c:7092
zfs_ioc_release  module/zfs/zfs_ioctl.c:7166
zfs_ioc_rollback  module/zfs/zfs_ioctl.c:5120
zfs_ioc_snapshot  module/zfs/zfs_ioctl.c:4168
zfs_release  lib/libzfs/libzfs_dataset.c:5061
zfs_rollback  lib/libzfs/libzfs_dataset.c:4318
zfs_snapshot_nvl  lib/libzfs/libzfs_dataset.c:4137
zfs_unmount_snap  module/zfs/zfs_ioctl.c:4347
zio_brt_free  module/zfs/zio.c:3803
zio_ddt_free  module/zfs/zio.c:4628
zio_dva_free  module/zfs/zio.c:4955
zio_free  module/zfs/zio.c:1435
zio_free_bp_init  module/zfs/zio.c:2195
zio_free_sync  module/zfs/zio.c:1477
zio_nowait  module/zfs/zio.c:2890
zio_wait  module/zfs/zio.c:2841
```

## Appendix C. Wire source references

195 references for the 74 wires, at commit `c913da8615`. Each line is `<wire>  <file>:<line>  <symbol>`, and the symbol appears verbatim on that source line. A wire's references are listed in the order of the calls in its label.

```
E001  cmd/zfs/zfs_main.c:4709  zfs_snapshot_nvl
E001  lib/libzfs/libzfs_dataset.c:4183  lzc_snapshot
E002  cmd/zfs/zfs_main.c:1814  zfs_destroy_snaps_nvl
E002  lib/libzfs/libzfs_dataset.c:3909  lzc_destroy_snaps
E003  cmd/zfs/zfs_main.c:1532  destroy_batched
E003  cmd/zfs/zfs_main.c:1535  zfs_destroy
E003  lib/libzfs/libzfs_dataset.c:3834  lzc_destroy
E004  cmd/zfs/zfs_main.c:4492  zfs_rollback
E004  lib/libzfs/libzfs_dataset.c:4340  rollback_destroy
E004  lib/libzfs/libzfs_dataset.c:4366  lzc_rollback_to
E005  cmd/zfs/zfs_main.c:8437  lzc_bookmark
E006  cmd/zfs/zfs_main.c:6727  zfs_hold
E006  lib/libzfs/libzfs_dataset.c:4956  zfs_hold_nvl
E006  lib/libzfs/libzfs_dataset.c:4972  lzc_hold
E007  cmd/zfs/zfs_main.c:6730  zfs_release
E007  lib/libzfs/libzfs_dataset.c:5092  lzc_release
E008  lib/libzfs_core/libzfs_core.c:421  ZFS_IOC_SNAPSHOT
E008  module/zfs/zfs_ioctl.c:8007  zfs_ioc_snapshot
E009  lib/libzfs_core/libzfs_core.c:471  ZFS_IOC_DESTROY_SNAPS
E009  module/zfs/zfs_ioctl.c:8047  zfs_ioc_destroy_snaps
E009  module/zfs/zfs_ioctl.c:4427  zfs_unmount_snap
E010  lib/libzfs_core/libzfs_core.c:379  ZFS_IOC_DESTROY
E010  module/zfs/zfs_ioctl.c:8313  zfs_ioc_destroy
E011  lib/libzfs_core/libzfs_core.c:1497  ZFS_IOC_ROLLBACK
E011  module/zfs/zfs_ioctl.c:8066  zfs_ioc_rollback
E011  module/zfs/zfs_ioctl.c:5144  zfs_suspend_fs
E012  lib/libzfs_core/libzfs_core.c:1532  ZFS_IOC_BOOKMARK
E012  module/zfs/zfs_ioctl.c:8071  zfs_ioc_bookmark
E013  lib/libzfs_core/libzfs_core.c:597  ZFS_IOC_HOLD
E013  module/zfs/zfs_ioctl.c:8052  zfs_ioc_hold
E014  lib/libzfs_core/libzfs_core.c:637  ZFS_IOC_RELEASE
E014  module/zfs/zfs_ioctl.c:8056  zfs_ioc_release
E015  module/zfs/zfs_ioctl.c:4238  dsl_dataset_snapshot
E015  module/zfs/zfs_ioctl.c:4434  dsl_destroy_snapshots_nvl
E015  module/zfs/zfs_ioctl.c:4727  dsl_destroy_head
E015  module/zfs/zfs_ioctl.c:5148  dsl_dataset_rollback
E015  module/zfs/zfs_ioctl.c:4458  dsl_bookmark_create
E015  module/zfs/zfs_ioctl.c:7123  dsl_dataset_user_hold
E015  module/zfs/zfs_ioctl.c:7169  dsl_dataset_user_release
E016  module/zfs/dsl_dataset.c:2010  dsl_sync_task
E016  module/zfs/dsl_destroy.c:626  dsl_sync_task
E016  module/zfs/dsl_destroy.c:1314  dsl_sync_task
E016  module/zfs/dsl_dataset.c:3479  dsl_sync_task
E016  module/zfs/dsl_bookmark.c:638  dsl_sync_task
E016  module/zfs/dsl_userhold.c:333  dsl_sync_task
E016  module/zfs/dsl_userhold.c:630  dsl_sync_task
E016  module/zfs/dsl_synctask.c:64  dst_checkfunc
E017  module/zfs/dsl_synctask.c:50  dmu_tx_create_dd
E017  module/zfs/dsl_synctask.c:51  dmu_tx_assign
E017  module/zfs/dsl_synctask.c:75  txg_list_add_tail
E017  module/zfs/dsl_synctask.c:77  dmu_tx_commit
E018  module/zfs/dsl_synctask.c:91  txg_wait_synced
E018  module/zfs/dsl_synctask.c:94  TXG_DEFER_SIZE
E019  module/zfs/txg.c:602  spa_sync
E020  module/zfs/spa.c:11208  dsl_pool_sync
E021  module/zfs/dsl_pool.c:876  dsl_sync_task_sync
E021  module/zfs/dsl_synctask.c:244  dst_checkfunc
E021  module/zfs/dsl_dataset.c:1549  ds_prev_snap_txg
E021  module/zfs/dsl_synctask.c:246  dst_syncfunc
E021  module/zfs/dsl_dataset.c:2011  dsl_dataset_snapshot_sync
E021  module/zfs/dsl_dataset.c:1942  dsl_dataset_snapshot_sync_impl
E022  module/zfs/dsl_pool.c:876  dsl_sync_task_sync
E022  module/zfs/dsl_userhold.c:334  dsl_dataset_user_hold_sync
E022  module/zfs/dsl_userhold.c:631  dsl_dataset_user_release_sync
E023  module/zfs/dsl_pool.c:876  dsl_sync_task_sync
E023  module/zfs/dsl_destroy.c:627  dsl_destroy_snapshot_sync
E024  module/zfs/dsl_pool.c:876  dsl_sync_task_sync
E024  module/zfs/dsl_destroy.c:1315  dsl_destroy_head_sync
E025  module/zfs/dsl_pool.c:876  dsl_sync_task_sync
E025  module/zfs/dsl_dataset.c:3480  dsl_dataset_rollback_sync
E026  module/zfs/dsl_pool.c:876  dsl_sync_task_sync
E026  module/zfs/dsl_bookmark.c:639  dsl_bookmark_create_sync
E026  module/zfs/dsl_bookmark.c:611  dsl_bookmark_create_sync_impl_snap
E027  module/zfs/dsl_dataset.c:1787  ds_deadlist_obj
E027  module/zfs/dsl_dataset.c:1843  dsl_deadlist_clone
E027  module/zfs/dsl_dataset.c:1848  dsl_deadlist_add_key
E028  module/zfs/dsl_dataset.c:1794  ds_bp
E028  module/zfs/dsl_dataset.c:1788  ds_referenced_bytes
E028  module/zfs/dsl_dataset.c:1894  ds_prev_snap_txg
E028  module/zfs/dsl_dataset.c:1895  ds_unique_bytes
E029  module/zfs/dsl_dataset.c:1850  dsl_bookmark_snapshotted
E030  module/zfs/dsl_pool.c:744  dsl_dataset_sync
E030  module/zfs/dsl_dataset.c:2161  dmu_objset_sync
E030  module/zfs/dbuf.c:5603  dbuf_write_done
E031  module/zfs/dbuf.c:5229  ZIO_FLAG_NOPWRITE
E031  module/zfs/dbuf.c:5233  dsl_dataset_block_kill
E031  module/zfs/dbuf.c:5234  dsl_dataset_block_born
E032  module/zfs/dmu_objset.c:1488  dnode_sync
E032  module/zfs/dnode_sync.c:838  dnode_sync_free_ranges
E033  module/zfs/dnode_sync.c:137  dsl_dataset_block_kill
E034  module/zfs/dsl_dataset.c:304  ds_prev_snap_txg
E034  module/zfs/dsl_dataset.c:323  dsl_free
E034  module/zfs/dsl_dataset.c:326  ds_unique_delta
E035  module/zfs/dsl_dataset.c:313  BP_IS_GANG
E035  module/zfs/dsl_dataset.c:313  BP_GET_DEDUP
E035  module/zfs/dsl_dataset.c:314  brt_maybe_exists
E035  module/zfs/dsl_dataset.c:318  bpobj_enqueue
E035  module/zfs/dsl_dataset.c:331  dp_free_dir
E036  module/zfs/dsl_dataset.c:304  ds_prev_snap_txg
E036  module/zfs/dsl_dataset.c:348  dsl_deadlist_insert
E036  module/zfs/dsl_dataset.c:346  ds_pending_deadlist
E037  module/zfs/dsl_pool.c:816  dsl_dataset_sync_done
E037  module/zfs/dsl_dataset.c:2397  ds_pending_deadlist
E037  module/zfs/dsl_dataset.c:2398  dsl_deadlist_insert_alloc_cb
E038  module/zfs/dsl_dataset.c:326  ds_unique_delta
E038  module/zfs/dsl_dataset.c:335  ds_dead_delta
E038  module/zfs/dsl_dataset.c:360  ds_snap_xfer_delta
E038  module/zfs/dsl_dataset.c:357  ds_prev_unique_delta
E038  module/zfs/dsl_dataset.c:2395  dsl_dataset_apply_deltas
E039  module/zfs/dsl_dataset.c:363  dsl_bookmark_block_killed
E039  module/zfs/dsl_bookmark.c:1515  BP_GET_BIRTH
E039  module/zfs/dsl_bookmark.c:1516  zbm_creation_txg
E040  module/zfs/dsl_dataset.c:296  dd_origin_txg
E040  module/zfs/dsl_dataset.c:301  dd_pending_frees
E040  module/zfs/dsl_dataset.c:214  dd_pending_allocs
E041  module/zfs/dsl_dataset.c:2401  dsl_flush_pending_livelist
E041  module/zfs/dsl_dataset.c:2402  dsl_livelist_should_disable
E042  module/zfs/dsl_scan.c:1580  zio_free
E042  module/zfs/zio.c:1467  zio_free_sync
E042  module/zfs/zio.c:1506  metaslab_free
E043  module/zfs/zio.c:1465  bplist_append
E043  module/zfs/spa.c:11218  spa_sync_frees
E043  module/zfs/zio.c:1498  ZIO_FREE_PIPELINE
E043  module/zfs/zio.c:1500  zio_create
E044  module/zfs/zio.c:1498  ZIO_FREE_PIPELINE
E045  module/zfs/zio.c:3815  brt_entry_decref
E046  module/zfs/zio.c:4962  metaslab_free
E047  module/zfs/dsl_destroy.c:78  ds_userrefs
E047  module/zfs/dsl_destroy.c:326  DS_FLAG_DEFER_DESTROY
E048  module/zfs/dsl_userhold.c:544  dsl_destroy_snapshot_sync_impl
E048  module/zfs/dsl_userhold.c:415  DS_IS_DEFER_DESTROY
E049  module/zfs/dsl_destroy.c:354  dsl_bookmark_ds_destroyed
E050  module/zfs/dsl_destroy.c:398  ds_prev_snap_txg
E050  module/zfs/dsl_destroy.c:424  dsl_deadlist_move_bpobj
E050  module/zfs/dsl_destroy.c:431  dsl_deadlist_merge
E051  module/zfs/dsl_deadlist.c:961  bpobj_enqueue_subobj
E051  module/zfs/dsl_destroy.c:427  dp_free_dir
E052  module/zfs/dsl_deadlist.c:902  dsl_deadlist_insert_bpobj
E053  module/zfs/dsl_destroy.c:417  dsl_deadlist_space_range
E053  module/zfs/dsl_destroy.c:420  dsl_dir_diduse_space
E053  module/zfs/dsl_destroy.c:413  ds_unique_bytes
E053  module/zfs/dsl_destroy.c:474  ds_unique_bytes
E053  module/zfs/dsl_destroy.c:504  dsl_dataset_recalc_head_uniq
E054  module/zfs/dsl_destroy.c:451  dsl_dir_remove_clones_key
E054  module/zfs/dsl_destroy.c:485  dsl_deadlist_remove_key
E055  module/zfs/spa.c:11231  dsl_scan_sync
E055  module/zfs/dsl_scan.c:4547  spa_sync_pass
E056  module/zfs/dsl_scan.c:4593  dsl_scan_active
E056  module/zfs/dsl_scan.c:4620  dsl_process_async_destroys
E057  module/zfs/dsl_scan.c:3987  bpobj_iterate
E057  module/zfs/dsl_scan.c:3988  bpobj_dsl_scan_free_block_cb
E058  module/zfs/dsl_scan.c:3761  zio_free_sync
E058  module/zfs/dsl_scan.c:3763  dp_free_dir
E059  module/zfs/dsl_scan.c:3720  zfs_async_block_max_blocks
E059  module/zfs/dsl_scan.c:3725  zfs_max_async_dedup_frees
E059  module/zfs/dsl_scan.c:3744  zfs_txg_timeout
E059  module/zfs/dsl_scan.c:3745  scn_async_block_min_time_ms
E059  module/zfs/dsl_scan.c:3758  ERESTART
E060  module/zfs/dsl_destroy.c:1127  dsl_deadlist_free
E061  module/zfs/dsl_destroy.c:1143  dsl_async_dataset_destroy
E061  module/zfs/dsl_destroy.c:1052  bptree_add
E061  module/zfs/dsl_destroy.c:1059  dp_free_dir
E061  module/zfs/dsl_destroy.c:1033  spa_feature_incr
E062  module/zfs/dsl_destroy.c:1140  dsl_async_clone_destroy
E062  module/zfs/dsl_destroy.c:997  zap_add_int
E062  module/zfs/dsl_destroy.c:1004  dp_free_dir
E062  module/zfs/dsl_destroy.c:1007  zthr_wakeup
E063  module/zfs/dsl_destroy.c:1145  old_synchronous_dataset_destroy
E063  module/zfs/dsl_destroy.c:807  traverse_dataset
E063  module/zfs/dsl_destroy.c:783  dsl_dataset_block_kill
E064  module/zfs/dsl_scan.c:4001  bptree_iterate
E064  module/zfs/dsl_scan.c:4015  spa_feature_decr
E065  module/zfs/bptree.c:225  traverse_dataset_destroyed
E066  module/zfs/dmu_traverse.c:272  td_min_txg
E066  module/zfs/bptree.c:207  TRAVERSE_POST
E066  module/zfs/bptree.c:154  ba_func
E067  module/zfs/bptree.c:240  dmu_write
E067  module/zfs/bptree.c:269  bt_begin
E068  module/zfs/spa.c:3417  dsl_process_sub_livelist
E069  module/zfs/spa.c:3430  dsl_sync_task
E069  module/zfs/spa.c:3354  delete_blkptr_cb
E069  module/zfs/spa.c:3311  zio_free
E070  module/zfs/dsl_dataset.c:3441  dsl_dataset_create_sync
E070  module/zfs/dsl_dataset.c:1237  ds_bp
E071  module/zfs/dsl_dataset.c:3446  dsl_dataset_clone_swap_sync_impl
E071  module/zfs/dsl_dataset.c:4428  ds_bp
E071  module/zfs/dsl_dataset.c:4502  ds_deadlist_obj
E071  module/zfs/dsl_dataset.c:4490  ds_unique_bytes
E072  module/zfs/dsl_dataset.c:3447  dsl_dataset_zero_zil
E072  module/zfs/dsl_dataset.c:3449  dsl_destroy_head_sync_impl
E073  module/zfs/dsl_dataset.c:3384  dsl_bookmark_latest_txg
E074  module/zfs/dsl_bookmark.c:454  dsl_bookmark_set_phys
E074  module/zfs/dsl_bookmark.c:348  zbm_guid
E074  module/zfs/dsl_bookmark.c:349  zbm_creation_txg
E074  module/zfs/dsl_bookmark.c:515  dsl_bookmark_node_add
E075  cmd/zfs/zfs_main.c:197  zfs_do_snapshot
E076  cmd/zfs/zfs_main.c:195  zfs_do_destroy
E077  cmd/zfs/zfs_main.c:230  zfs_do_hold
E078  cmd/zfs/zfs_main.c:198  zfs_do_rollback
E079  cmd/zfs/zfs_main.c:202  zfs_do_bookmark
```

## Appendix D. Tunable and property source references

Where each tunable and property named in section 8 is declared, at commit `c913da8615`. Same format as Appendix C, keyed by name. A tunable's symbol is the name part as written in its `ZFS_MODULE_PARAM` line; a property's symbol is its quoted name in the `zprop_register_*()` call (`freeing` is a pool property, in `zpool_prop.c`).

```
zfs_async_block_max_blocks  module/zfs/dsl_scan.c:5539  async_block_max_blocks
zfs_free_bpobj_enabled  module/zfs/dsl_scan.c:5548  free_bpobj_enabled
zfs_free_min_time_ms  module/zfs/dsl_scan.c:5524  free_min_time_ms
zfs_livelist_max_entries  module/zfs/dsl_deadlist.c:1114  max_entries
zfs_livelist_min_percent_shared  module/zfs/dsl_deadlist.c:1117  min_percent_shared
zfs_max_async_dedup_frees  module/zfs/dsl_scan.c:5542  max_async_dedup_frees
defer_destroy  module/zcommon/zfs_prop.c:543  "defer_destroy"
freeing  module/zcommon/zpool_prop.c:117  "freeing"
referenced  module/zcommon/zfs_prop.c:631  "referenced"
used  module/zcommon/zfs_prop.c:626  "used"
usedbydataset  module/zcommon/zfs_prop.c:650  "usedbydataset"
usedbysnapshots  module/zcommon/zfs_prop.c:647  "usedbysnapshots"
userrefs  module/zcommon/zfs_prop.c:660  "userrefs"
```

## Appendix E. Timelines

Six scenarios in the grammar of `zfs-viewer-suite-spec.md` section 6. Block ids, dataset names and txgs are illustrative. The rules they show are the code's: a killed block is freed when its birth txg is greater than the head's ds_prev_snap_txg and goes on the head's deadlist otherwise (E034, E036); a snapshot destroy queues the blocks on the next dataset's deadlist born after the destroyed snapshot's previous snapshot and keeps the rest (E050 to E052); freed space is allocatable TXG_DEFER_SIZE (2) txgs after the txg that freed it (E042). State `async` means queued on the pool free list or in the bptree, `deferred` means freed in a metaslab but not yet allocatable.

### E.1 `snapshot_overwrite` - Snapshot, then overwrite a block twice

One snapshot and two overwrites of the same block. The first overwrite kills a block the snapshot shares, which goes on the deadlist; the second kills a block born after the snapshot, which is freed at once.

```
STEP 1 txg=100 "fs holds blocks A and B and has no snapshot yet"
  DS fs head
  BLK A birth=90 in=fs
  BLK B birth=95 in=fs
  NOTE "Without a snapshot, any block fs stops using is freed at once"
STEP 2 txg=105 "zfs snapshot fs@s1 in txg 105" path=snapshot_create@11 wires=E027,E028
  DS fs head prev=fs@s1
  DS fs@s1 snapshot txg=105
  BLK A birth=90 in=fs,fs@s1
  BLK B birth=95 in=fs,fs@s1
  NOTE "Nothing is copied. fs@s1 shares the root block pointer of fs, and the ds_prev_snap_txg of fs becomes 105."
STEP 3 txg=110 "Overwrite B. Its birth 95 is not greater than 105, so B goes on the deadlist of fs" path=overwrite@10 wires=E036,E038
  DS fs head prev=fs@s1
  DS fs@s1 snapshot txg=105
  BLK A birth=90 in=fs,fs@s1
  BLK B birth=95 in=fs@s1 dead=fs
  BLK B2 birth=110 in=fs
  NOTE "No space comes back. B now counts in the used property of fs@s1 and in the usedbysnapshots property of fs."
STEP 4 txg=115 "Overwrite B2. Its birth 110 is greater than 105, so B2 is freed in this txg" path=overwrite@7 wires=E034,E042
  DS fs head prev=fs@s1
  DS fs@s1 snapshot txg=105
  BLK A birth=90 in=fs,fs@s1
  BLK B birth=95 in=fs@s1 dead=fs
  BLK B2 birth=110 state=deferred
  BLK B3 birth=115 in=fs
  NOTE "metaslab_free() holds the space back for TXG_DEFER_SIZE (2) txgs"
STEP 5 txg=118 "The deferral of B2 is over and its space can be allocated again" wires=E042
  DS fs head prev=fs@s1
  DS fs@s1 snapshot txg=105
  BLK A birth=90 in=fs,fs@s1
  BLK B birth=95 in=fs@s1 dead=fs
  BLK B2 birth=110 state=freed
  BLK B3 birth=115 in=fs
```

### E.2 `destroy_middle` - Three snapshots, destroy the middle one

Blocks die between different snapshots, then the middle snapshot is destroyed. Only the block that the middle snapshot alone held is freed; a block the older snapshot still needs stays on the deadlist and becomes unique to that snapshot.

```
STEP 1 txg=100 "zfs snapshot fs@s1 while fs holds A, D and B" path=snapshot_create@11 wires=E027
  DS fs head prev=fs@s1
  DS fs@s1 snapshot txg=100
  BLK A birth=90 in=fs,fs@s1
  BLK D birth=93 in=fs,fs@s1
  BLK B birth=95 in=fs,fs@s1
STEP 2 txg=105 "C was written in txg 103; now B is overwritten by B2 and goes on the deadlist of fs (95 is not greater than 100)" path=overwrite@10 wires=E036
  DS fs head prev=fs@s1
  DS fs@s1 snapshot txg=100
  BLK A birth=90 in=fs,fs@s1
  BLK D birth=93 in=fs,fs@s1
  BLK B birth=95 in=fs@s1 dead=fs
  BLK C birth=103 in=fs
  BLK B2 birth=105 in=fs
STEP 3 txg=110 "zfs snapshot fs@s2. It takes over the deadlist of fs, with B in it" path=snapshot_create@11 wires=E027
  DS fs head prev=fs@s2
  DS fs@s2 snapshot prev=fs@s1 txg=110
  DS fs@s1 snapshot txg=100
  BLK A birth=90 in=fs,fs@s2,fs@s1
  BLK D birth=93 in=fs,fs@s2,fs@s1
  BLK B birth=95 in=fs@s1 dead=fs@s2
  BLK C birth=103 in=fs,fs@s2
  BLK B2 birth=105 in=fs,fs@s2
  NOTE "fs starts a new, empty deadlist"
STEP 4 txg=115 "Remove the file that holds C and D. Births 103 and 93 are not greater than 110, so both go on the deadlist of fs" path=overwrite@6 wires=E033,E036
  DS fs head prev=fs@s2
  DS fs@s2 snapshot prev=fs@s1 txg=110
  DS fs@s1 snapshot txg=100
  BLK A birth=90 in=fs,fs@s2,fs@s1
  BLK D birth=93 in=fs@s2,fs@s1 dead=fs
  BLK B birth=95 in=fs@s1 dead=fs@s2
  BLK C birth=103 in=fs@s2 dead=fs
  BLK B2 birth=105 in=fs,fs@s2
  NOTE "D lands in the sub-list for births up to 100, C in the sub-list for births after 100"
STEP 5 txg=120 "zfs snapshot fs@s3. It takes over the deadlist with C and D" path=snapshot_create@11 wires=E027
  DS fs head prev=fs@s3
  DS fs@s3 snapshot prev=fs@s2 txg=120
  DS fs@s2 snapshot prev=fs@s1 txg=110
  DS fs@s1 snapshot txg=100
  BLK A birth=90 in=fs,fs@s3,fs@s2,fs@s1
  BLK D birth=93 in=fs@s2,fs@s1 dead=fs@s3
  BLK B birth=95 in=fs@s1 dead=fs@s2
  BLK C birth=103 in=fs@s2 dead=fs@s3
  BLK B2 birth=105 in=fs,fs@s3,fs@s2
STEP 6 txg=125 "zfs destroy fs@s2. On the deadlist of fs@s3, the sub-lists for births after 100 (the previous snapshot of fs@s2) go to the pool free list, so C is queued" path=destroy_snapshot@12 wires=E050,E051,E052
  DS fs head prev=fs@s3
  DS fs@s3 snapshot prev=fs@s1 txg=120
  DS fs@s1 snapshot txg=100
  BLK A birth=90 in=fs,fs@s3,fs@s1
  BLK D birth=93 in=fs@s1 dead=fs@s3
  BLK B birth=95 in=fs@s1 dead=fs@s3
  BLK C birth=103 state=async
  BLK B2 birth=105 in=fs,fs@s3
  NOTE "D was born at 93, so fs@s1 still needs it. It stays on the deadlist of fs@s3 and now counts in the used property of fs@s1."
  NOTE "The deadlist of fs@s2 (with B) is merged into the deadlist of fs@s3"
STEP 7 txg=126 "In the next sync, dsl_process_async_destroys() frees C from the pool free list" path=free_drain@5 wires=E057,E058
  DS fs head prev=fs@s3
  DS fs@s3 snapshot prev=fs@s1 txg=120
  DS fs@s1 snapshot txg=100
  BLK A birth=90 in=fs,fs@s3,fs@s1
  BLK D birth=93 in=fs@s1 dead=fs@s3
  BLK B birth=95 in=fs@s1 dead=fs@s3
  BLK C birth=103 state=deferred
  BLK B2 birth=105 in=fs,fs@s3
```

### E.3 `delete_then_destroy` - Delete a file, then destroy the snapshot that holds it

The everyday case: removing a file frees nothing while a snapshot holds its blocks; destroying the snapshot queues them, and the background free returns the space a txg later.

```
STEP 1 txg=200 "zfs snapshot fs@s1. The file blocks F1 and F2 and another block G were born before it" path=snapshot_create@10 wires=E021
  DS fs head prev=fs@s1
  DS fs@s1 snapshot txg=200
  BLK F1 birth=150 in=fs,fs@s1
  BLK F2 birth=160 in=fs,fs@s1
  BLK G birth=170 in=fs,fs@s1
STEP 2 txg=210 "rm the file. Births 150 and 160 are not greater than 200, so dsl_dataset_block_kill() puts F1 and F2 on the deadlist of fs" path=overwrite@6 wires=E033,E036,E038
  DS fs head prev=fs@s1
  DS fs@s1 snapshot txg=200
  BLK F1 birth=150 in=fs@s1 dead=fs
  BLK F2 birth=160 in=fs@s1 dead=fs
  BLK G birth=170 in=fs,fs@s1
  NOTE "The pool gets no space back. fs references less, and the used property of fs@s1 grows by F1 and F2."
STEP 3 txg=220 "zfs destroy fs@s1. Its previous-snapshot txg is the pool origin, older than any block, so the whole deadlist of fs goes to the pool free list" path=destroy_snapshot@13 wires=E050,E051
  DS fs head
  BLK F1 birth=150 state=async
  BLK F2 birth=160 state=async
  BLK G birth=170 in=fs
  NOTE "The command returns now; the pool property freeing shows F1 and F2 until the background free has run"
STEP 4 txg=221 "In the next sync, the background free releases F1 and F2" path=free_drain@5 wires=E058
  DS fs head
  BLK F1 birth=150 state=deferred
  BLK F2 birth=160 state=deferred
  BLK G birth=170 in=fs
  NOTE "Their space is allocatable from txg 224"
```

### E.4 `rollback` - Roll back to the latest snapshot

A rollback after an overwrite and a new write. The head gets the snapshot's tree back; the blocks born after the snapshot are queued in the bptree and freed in the background.

```
STEP 1 txg=300 "zfs snapshot fs@s1 while fs holds A and B" path=snapshot_create@11 wires=E027,E028
  DS fs head prev=fs@s1
  DS fs@s1 snapshot txg=300
  BLK A birth=250 in=fs,fs@s1
  BLK B birth=260 in=fs,fs@s1
STEP 2 txg=305 "C was written in txg 304; now B is overwritten by B2 and goes on the deadlist of fs" path=overwrite@10 wires=E036
  DS fs head prev=fs@s1
  DS fs@s1 snapshot txg=300
  BLK A birth=250 in=fs,fs@s1
  BLK B birth=260 in=fs@s1 dead=fs
  BLK C birth=304 in=fs
  BLK B2 birth=305 in=fs
STEP 3 txg=310 "zfs rollback fs@s1. The head swaps contents with the clone %rollback of fs@s1 and references A and B again" path=rollback@12 wires=E070,E071,E072
  DS fs head prev=fs@s1
  DS fs@s1 snapshot txg=300
  BLK A birth=250 in=fs,fs@s1
  BLK B birth=260 in=fs,fs@s1
  BLK C birth=304 state=async
  BLK B2 birth=305 state=async
  NOTE "The old deadlist of fs (with B) is dropped unread, because fs@s1 still holds B. The head starts with an empty deadlist."
  NOTE "Destroying the clone put its tree in the bptree with birth txg 300, so only C and B2 will be freed"
STEP 4 txg=311 "In the next sync, the bptree traversal frees C and B2" path=rollback@19 wires=E066,E058
  DS fs head prev=fs@s1
  DS fs@s1 snapshot txg=300
  BLK A birth=250 in=fs,fs@s1
  BLK B birth=260 in=fs,fs@s1
  BLK C birth=304 state=deferred
  BLK B2 birth=305 state=deferred
```

### E.5 `async_fs_destroy` - Destroy a file system over several txgs

zfs destroy returns after one txg, but the blocks are freed a time-limited slice per txg. The pool property freeing counts down while it happens.

```
STEP 1 txg=500 "tank/big holds P, Q, R and S and has no snapshots; tank/home is another file system"
  DS tank/big head
  DS tank/home head
  BLK P birth=400 in=tank/big
  BLK Q birth=410 in=tank/big
  BLK R birth=420 in=tank/big
  BLK S birth=430 in=tank/big
  BLK H birth=450 in=tank/home
STEP 2 txg=505 "zfs destroy tank/big. dsl_async_dataset_destroy() puts its root block pointer in the bptree and moves its space to freeing" path=destroy_filesystem@12 wires=E061
  DS tank/home head
  BLK P birth=400 state=async
  BLK Q birth=410 state=async
  BLK R birth=420 state=async
  BLK S birth=430 state=async
  BLK H birth=450 in=tank/home
  NOTE "The entry's birth txg is the ds_prev_snap_txg of tank/big, older than all its blocks, so all four will be freed. Nothing is free yet."
STEP 3 txg=506 "Next sync. The traversal frees P and Q, then dsl_scan_async_block_should_pause() stops it for this txg" path=destroy_filesystem@20 wires=E066,E059
  DS tank/home head
  BLK P birth=400 state=deferred
  BLK Q birth=410 state=deferred
  BLK R birth=420 state=async
  BLK S birth=430 state=async
  BLK H birth=450 in=tank/home
  NOTE "For example zfs_free_min_time_ms (500 ms) has passed while a txg sync is waiting. The traversal position is saved in the bptree entry."
STEP 4 txg=507 "Next sync. The traversal resumes at the saved bookmark and frees R and S; the bptree is empty and async_destroy is deactivated" path=destroy_filesystem@18 wires=E067,E064
  DS tank/home head
  BLK P birth=400 state=deferred
  BLK Q birth=410 state=deferred
  BLK R birth=420 state=deferred
  BLK S birth=430 state=deferred
  BLK H birth=450 in=tank/home
  NOTE "freeing is back to 0, but none of the space is allocatable yet"
STEP 5 txg=510 "The deferrals are over; all four blocks are allocatable" wires=E042
  DS tank/home head
  BLK P birth=400 state=freed
  BLK Q birth=410 state=freed
  BLK R birth=420 state=freed
  BLK S birth=430 state=freed
  BLK H birth=450 in=tank/home
```

### E.6 `bookmark_source` - Bookmark a snapshot, then destroy the snapshot

A bookmark keeps no blocks: destroying its snapshot frees the snapshot's blocks as usual, and the bookmark still identifies the snapshot as an incremental send source.

```
STEP 1 txg=600 "zfs snapshot fs@s1 while fs holds A and B" path=snapshot_create@11 wires=E027
  DS fs head prev=fs@s1
  DS fs@s1 snapshot txg=600
  BLK A birth=550 in=fs,fs@s1
  BLK B birth=560 in=fs,fs@s1
STEP 2 txg=602 "zfs bookmark fs@s1 fs#b1" path=bookmark_create@11 wires=E074
  DS fs head prev=fs@s1
  DS fs@s1 snapshot txg=600
  DS fs#b1 bookmark txg=600
  BLK A birth=550 in=fs,fs@s1
  BLK B birth=560 in=fs,fs@s1
  NOTE "b1 records the guid and creation txg 600 of fs@s1. It references no block."
STEP 3 txg=605 "Overwrite B. Its birth 560 is not greater than 600, so B goes on the deadlist of fs" path=overwrite@10 wires=E036,E039
  DS fs head prev=fs@s1
  DS fs@s1 snapshot txg=600
  DS fs#b1 bookmark txg=600
  BLK A birth=550 in=fs,fs@s1
  BLK B birth=560 in=fs@s1 dead=fs
  BLK B2 birth=605 in=fs
  NOTE "With the bookmark_written feature, B is also added to the space b1 counts as freed since it was taken"
STEP 4 txg=610 "zfs destroy fs@s1. Only fs@s1 held B, so B goes to the pool free list; the bookmark stays" path=destroy_snapshot@11 wires=E049,E051
  DS fs head
  DS fs#b1 bookmark txg=600
  BLK A birth=550 in=fs
  BLK B birth=560 state=async
  BLK B2 birth=605 in=fs
  NOTE "dsl_bookmark_ds_destroyed() clears the snapshot-exists flag of b1; the bookmark itself is untouched"
STEP 5 txg=611 "In the next sync, the background free releases B" path=free_drain@5 wires=E058
  DS fs head
  DS fs#b1 bookmark txg=600
  BLK A birth=550 in=fs
  BLK B birth=560 state=deferred
  BLK B2 birth=605 in=fs
STEP 6 txg=620 "zfs snapshot fs@s2" path=snapshot_create@11 wires=E027
  DS fs head prev=fs@s2
  DS fs@s2 snapshot txg=620
  DS fs#b1 bookmark txg=600
  BLK A birth=550 in=fs,fs@s2
  BLK B birth=560 state=freed
  BLK B2 birth=605 in=fs,fs@s2
  NOTE "zfs send -i fs#b1 fs@s2 still works without fs@s1: the bookmark supplies the source guid and txg 600, and the stream carries the blocks born after it (B2)"
```
