# ZFS destroy actions (build spec)

This diagram follows the destroy commands end to end: what `zfs destroy` does, and in what order, for a snapshot, a snapshot range, a file system or a volume (with `-r`, `-R`, `-f`, `-d`, `-n` and `-v`), what `zpool destroy` does to a pool, why each of them refuses (children, clones, holds, busy), and when the space actually comes back. The block-level freeing that a destroy starts (deadlists, the pool free list, the bptree, livelists) is drawn in detail in the snapshot lifecycle graph; this graph hands off to it.

Source of truth: `https://github.com/openzfs/zfs` at commit `c913da86156eba3243cc1ef515e98d69887654a7` (master, 2026-11-13, version 2.4.99). Every function name, file path and tunable in this document was checked against that commit.

## 0. Instructions to the building agent

Render this spec with the viewer in `../viewer/`, as extended by `zfs-viewer-suite-spec.md` (suite page `zfs-destroy.html`, graph view). Treat sections 6 to 10 and the appendices as data. Do not add, remove or re-route nodes, wires or paths without verifying the change at the pinned commit.

## 1. Goal

One page that lets a ZFS administrator answer "what exactly happens, and in what order, when I run `zfs destroy` on a snapshot, a file system or a volume, or `zpool destroy` on a pool; why does it refuse; and when does the space come back?"

### Mental model the diagram has to convey

1. `zfs destroy` is mostly a userspace program. zfs(8) works out what to destroy and in which order, refuses children and clones itself before anything changes, and unmounts file systems. The kernel destroys one file system or volume per call, or a list of snapshots, and refuses only what it can see: user holds, clones and datasets still in use.
2. The order is post-order: descendants before their parent, a snapshot's clones before the snapshot, a file system's snapshots before the file system. Contiguous snapshots are batched into one request, and the batch is sent before the next file system is unmounted and destroyed.
3. A list of snapshots is one ioctl but not one transaction. The kernel runs one sync task per snapshot, each waiting for its own txg; the first refusal stops the list, and the snapshots before it stay destroyed.
4. "Busy" means a long hold on the dataset: a mount, an open volume, a running send. A mounted file system is unmounted by zfs(8) first (`-f` forces it); an open volume is not closed for you. `zfs destroy -d` turns a refusal caused by holds, clones or a snapshot mount into a mark (`defer_destroy`), and the snapshot goes when the last of them does.
5. The command returns once the destroy is on disk, but the space returns later. A snapshot's unique blocks go to the pool free list, a file system's tree to the bptree and a clone's blocks to its livelist; `dsl_scan_sync()` frees a time-limited slice of them each txg (pool property `freeing`), and freed space is reusable TXG_DEFER_SIZE (2) txgs later.
6. `zpool destroy` frees nothing. It unmounts every file system, refuses while anything still holds the pool, writes `POOL_STATE_DESTROYED` into every label, unloads the pool and drops it from the cache file. The data stays on the disks, and `zpool import -D` can bring the pool back until they are reused.

### Scope

In scope: `zfs destroy` of snapshots (single, comma lists, `a%b` ranges, `-r`, `-R`, `-d`, `-n`, `-v`, `-p`), of file systems, clones and volumes (`-r`, `-R`, `-f`), the checks that refuse a destroy, unmount and unshare, zvol device removal, the destroy sync tasks, the hand-off to background freeing, and `zpool destroy` with the label state it leaves for `zpool import -D`.

Out of scope: bookmark destroy (`zfs destroy fs#mark`), destroys run from channel programs (`zfs program`), the block-level freeing itself (see the snapshot lifecycle graph), `zpool import` in general (only the `-D` filter is drawn), `zpool labelclear`, pool checkpoints, encryption key teardown of a destroyed dataset, FreeBSD-specific unmount code.

## 2. Deliverable

Built by `../viewer/build_graph.py --spec specs/zfs-destroy-spec.md` into the suite page `zfs-destroy.html`, graph view only.

## 6. Wire types and contexts

### 6.1 Wire types

| type id | colour | name | what travels on the wire |
|---|---|---|---|
| `ctl` | `#868E96` | Control | Calls that carry no payload or only names: requests, checks, refusals, unmounts, sync-task dispatch. Drawn dashed. |
| `tx` | `#FFD43B` | Transaction | A sync task joining the open txg, a txg being synced, or a wait for a txg. |
| `bp` | `#F783AC` | Block pointer | Blocks of a destroyed dataset handed to the freeing machinery: deadlist sub-lists, a root block pointer, livelist entries. |
| `alloc` | `#C59F7B` | Space | Segments returned to a metaslab. |
| `cfg` | `#FFD8A8` | Configuration and properties | Pool configuration: the pool state written into the labels, the cache file entry, label contents read at import. |

### 6.2 Execution contexts

| ctx id | meaning |
|---|---|
| `user` | Userspace |
| `syscall` | Kernel, in the thread of the calling process (an ioctl on /dev/zfs, mount(2) or umount(2)) or a helper thread it starts, outside syncing context and outside any dmu_tx |
| `sync` | Syncing context: txg_sync thread or dp_sync_taskq workers, one txg at a time |
| `thr` | A dedicated kernel thread or zthr |
| `any` | Runs in whichever context calls it |
| `hw` | Hardware |

## 7. Groups and default layout

| group id | title | colour | first column | band | sub-columns | nodes | summary |
|---|---|---|---|---|---|---|---|
| `cli` | Userspace: zfs(8), zpool(8), libzfs | `#5C5F66` | 0 | full | 2 | 8 | Decide what to destroy and in which order, refuse children and clones, unmount, and send the requests. |
| `entry` | Kernel entry: ioctls, holds, sync tasks | `#0C8599` | 2 | full | 2 | 9 | Unmount snapshots, drop volume devices, and run each destroy as a sync task. |
| `txg` | TXG sync (shared with the I/O graph) | `#E67700` | 4 | full | 1 | 3 | Where the queued destroy tasks run, after the txg's data is written. |
| `ops` | Destroy checks and sync tasks | `#1971C2` | 5 | full | 1 | 5 | Checks that refuse a destroy, and the sync functions that remove the dataset records. |
| `free` | Freeing (detail in the snapshot graph) | `#862E9C` | 6 | full | 1 | 6 | Where the destroyed blocks wait, and the background work that frees them a slice per txg. |
| `pool` | Pool destroy | `#C2255C` | 7 | full | 2 | 5 | spa_export_common() with POOL_STATE_DESTROYED: the labels, the final txgs and the cache file. |

Default layout rules:

- Column pitch is 400 px. A group starts at `first column * 400` and is `sub-columns` columns wide. A node's x is `(group first column + node sub-col) * 400`.
- Inside a sub-column, stack nodes top to bottom in the order they appear in the section 8 tables, 28 px apart. Node height follows its socket count.
- All groups use band `full` and start at the top.
- The layout must be deterministic. Do not run a force-directed or randomised layout in the page.
- Check the default at "fit all": group titles must be readable and no node may overlap another.

## 8. Nodes

36 nodes. `sub-col` is the node's column inside its group. `functions` are real symbols at the pinned commit (locations in Appendix A); the first one is the node's headline function. Nodes whose role starts with "Shared with the I/O flow graph." use the I/O graph's node id, title and context; other reused ids (`zfs_cmd`, `libzfs`, `mount_lib`, `zfs_ioctl`, `dsl_entry`, `sync_task`, `destroy_snap`, `hold_sync`, `destroy_head`, `deadlist_split`, `free_bpobj`, `bptree`, `livelist_del`, `async_destroy`) keep the title and context of the snapshot lifecycle and encryption graphs.

### 8.1 Userspace: zfs(8), zpool(8), libzfs (`cli`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `admin` | Administrator | 0 | `user` | - | - | The person or script typing the command. Every path in this graph that a command starts begins with a wire from this node; the arrows that come back into a command node are its results, errors and refusals. |
| `zfs_cmd` | zfs(8) command | 0 | `user` | `cmd/zfs/zfs_main.c` | `zfs_do_destroy`, `destroy_callback`, `destroy_batched` | zfs destroy. A name with @ is a snapshot list, a name with # a bookmark (not drawn), anything else a file system or volume; a pool's root file system is refused without -r. destroy_callback() gets every dataset to destroy in order: a snapshot is added to the current batch, a file system or volume first flushes the batch (destroy_batched()), is unmounted and is then destroyed. With -r an error on one dataset is remembered and the walk goes on. |
| `snap_gather` | Snapshot list (fs@a%b, -r) | 0 | `user` | `cmd/zfs/zfs_main.c` | `gather_snapshots`, `snapshot_to_nvl_cb`, `zfs_iter_snapspec_v2` | Expands the part after @: a comma-separated list of names and ranges, where a%b is every snapshot from a to b in creation order and an empty end means the first or the last. With -r the same spec is applied to every descendant file system. Every match goes into one nvlist; a name that matches nothing is skipped silently, and an empty list is an error. |
| `dep_walk` | Dependents check and walk (-r, -R) | 0 | `user` | `lib/libzfs/libzfs_iter.c` | `zfs_iter_dependents_v2`, `iter_dependents_cb`, `destroy_check_dependent`, `destroy_clones` | zfs_iter_dependents_v2() visits a dataset's dependents depth first and calls back after the children: child file systems first, then the snapshots in creation order, and each snapshot only after its clones. destroy_check_dependent() uses the same walk to refuse: children or snapshots without -r, clones without -R. |
| `dry_run` | Dry run and space estimate (-n, -v) | 0 | `user` | `cmd/zfs/zfs_main.c` | `destroy_print_snapshots`, `destroy_print_cb`, `lzc_snaprange_space` | With -v (or -p) for a snapshot list, walks each file system's snapshots in creation order, prints each selected one and asks the kernel how much each contiguous range would free. With -n nothing is destroyed. For a file system, -nv only lists the datasets, without an estimate. |
| `zpool_cmd` | zpool(8) command | 0 | `user` | `cmd/zpool/zpool_main.c` | `zpool_do_destroy`, `zpool_do_import`, `import_pools` | zpool destroy [-f] pool: unmount everything, then one ioctl. -f only forces the unmounts. zpool import -D is the way back: it lists and imports only pools whose labels say destroyed. |
| `libzfs` | libzfs / libzfs_core | 1 | `user` | `lib/libzfs_core/libzfs_core.c` | `zfs_destroy_snaps_nvl`, `zfs_destroy`, `lzc_destroy_snaps`, `lzc_destroy`, `zpool_destroy` | Turns each request into one ioctl: lzc_destroy_snaps() for a snapshot list (with defer for -d), lzc_destroy() for one file system or volume, ZFS_IOC_POOL_DESTROY for a pool. Translates the errors: EEXIST is "snapshot is cloned", EBUSY with user holds is "it's being held". |
| `mount_lib` | libzfs mount / unmount | 1 | `user` | `lib/libzfs/libzfs_mount.c` | `zfs_unmount`, `zfs_unshare`, `unmount_one`, `do_unmount`, `remove_mountpoint`, `zpool_disable_datasets` | Unshares (NFS, SMB) and unmounts a file system that /proc/self/mounts lists as mounted; a volume or an unmounted file system needs nothing. If the unmount fails the file system is shared again. After a destroy, remove_mountpoint() deletes the empty mountpoint directory when the mountpoint is default or inherited. For zpool destroy, zpool_disable_datasets() does the same for every mounted file system of the pool. Properties: `mountpoint`. |

### 8.2 Kernel entry: ioctls, holds, sync tasks (`entry`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `zfs_ioctl` | ZFS ioctl handlers | 0 | `syscall` | `module/zfs/zfs_ioctl.c` | `zfs_ioc_destroy_snaps`, `zfs_ioc_destroy`, `zfs_ioc_space_snaps`, `zfs_ioc_pool_destroy`, `zfs_unmount_snap`, `zfs_destroy_unmount_origin` | Kernel entry points. Before a snapshot destroy they unmount the snapshots and remove their volume devices; zfs_ioc_destroy() retries a file system destroy after removing a leftover %recv child; zfs_ioc_space_snaps() answers the dry-run estimate without changing anything. |
| `space_est` | Space estimate | 0 | `syscall` | `module/zfs/dsl_dataset.c` | `dsl_dataset_space_wouldfree`, `dsl_deadlist_space_range` | What destroying the snapshots first to last of one file system would free: for each dataset after a snapshot in the range, the space on its deadlist born after the snapshot before first. Read-only, under a pool hold. |
| `snap_umount` | Snapshot automount unmount | 0 | `syscall` | `module/os/linux/zfs/zfs_ctldir.c` | `zfsctl_snapshot_unmount`, `zfsctl_snapshot_unmount_wait` | A snapshot visited under .zfs/snapshot is automounted. Before it is destroyed it is unmounted, best effort: the kernel invalidates the mount and waits briefly until the snapshot has no long hold. |
| `vfs_umount` | Kernel unmount (zfs_umount) | 0 | `syscall` | `module/os/linux/zfs/zfs_vfsops.c` | `zfs_umount`, `zfsvfs_teardown`, `dmu_objset_disown` | umount(2) on a ZFS file system ends in zfs_umount() (from zpl_put_super()). It tears down the zfsvfs and gives up ownership of the objset, which drops the mount's long hold on the dataset. |
| `long_holds` | Dataset long holds | 0 | `any` | `module/zfs/dsl_dataset.c` | `dsl_dataset_long_held`, `dsl_dataset_long_hold`, `dsl_dataset_long_rele`, `dsl_dataset_disown`, `dsl_dataset_has_owner` | A long hold keeps a dataset from being destroyed while it is in use. Owners take one (a mounted file system, an open volume, a receive), and so do other long operations such as a send. Any long hold makes a destroy fail with EBUSY; only a snapshot whose holder is a mount can be marked with -d instead. |
| `dsl_entry` | DSL request functions | 1 | `syscall` | `module/zfs/dsl_destroy.c` | `dsl_destroy_snapshots_nvl`, `dsl_destroy_snapshot`, `dsl_destroy_head` | dsl_destroy_snapshots_nvl() runs one sync task per snapshot, in list order, and stops at the first error, so a failed request can leave the earlier snapshots destroyed. dsl_destroy_head() runs one sync task for the file system or volume (two, with an open-context pre-free in between, on pools without async_destroy). |
| `sync_task` | dsl_sync_task() | 1 | `syscall` | `module/zfs/dsl_synctask.c` | `dsl_sync_task`, `dsl_sync_task_common`, `dsl_sync_task_sync` | Runs a metadata change in syncing context. The check runs once in open context as a quick test, the task is queued on the open txg, and the caller waits until that txg has synced. In syncing context dsl_sync_task_sync() checks pool space and re-runs the check before the sync function. Destroys use ZFS_SPACE_CHECK_DESTROY, which may use three quarters of the slop space, so a nearly full pool can still destroy. |
| `prefree` | Old-pool pre-free and crash cleanup | 1 | `syscall` | `module/zfs/dsl_destroy.c` | `dmu_free_long_object`, `dmu_object_next`, `dsl_destroy_inconsistent` | Only on pools without the async_destroy feature, where the whole tree is freed in the destroy's txg. A first sync task marks the dataset inconsistent; then every object changed since the last snapshot is freed from open context so that the final txg stays short. If the system crashes in between, the next import finds the inconsistent dataset and finishes the destroy (dsl_destroy_inconsistent()), unless it is a resumable receive. |
| `zvol_minors` | zvol device removal | 1 | `any` | `module/zfs/zvol.c` | `zvol_remove_minors`, `zvol_remove_minors_impl`, `zvol_shutdown_minor` | Removes the /dev/zvol device of a volume, of its snapshots (present only with snapdev=visible) and of everything below a name. zvol_remove_minors() queues the work on the pool's zvol taskq; the destroy paths do not wait for it, zpool destroy does. Tunables: `zvol_inhibit_dev`. Properties: `snapdev`. |

### 8.3 TXG sync (shared with the I/O graph) (`txg`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `txg_sync` | TXG: syncing (txg_sync_thread) | 0 | `thr` | `module/zfs/txg.c` | `txg_sync_thread`, `txg_wait_synced` | Shared with the I/O flow graph. Syncs the txg a destroy task joined. txg_wait_synced() is why zfs destroy returns only when the destroy is on disk, and why zpool destroy can push the final label update out before the pool is unloaded. |
| `spa_sync` | spa_sync() | 0 | `sync` | `module/zfs/spa.c` | `spa_sync`, `spa_sync_iterate_to_convergence` | Shared with the I/O flow graph. Each pass runs dsl_pool_sync(), which runs the destroy tasks in pass 1; dsl_scan_sync() then frees queued blocks; every txg ends by rewriting the labels and uberblocks. |
| `dsl_pool_sync` | dsl_pool_sync() | 0 | `sync` | `module/zfs/dsl_pool.c` | `dsl_pool_sync` | Shared with the I/O flow graph. Writes the txg's dirty datasets first and only then runs the queued sync tasks, so a dataset destroyed in txg N had its last writes synced in the same txg. |

### 8.4 Destroy checks and sync tasks (`ops`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `snap_check` | Snapshot destroy checks | 0 | `any` | `module/zfs/dsl_destroy.c` | `dsl_destroy_snapshot_check`, `dsl_destroy_snapshot_check_impl` | Runs in open context and again in syncing context. A snapshot that no longer exists passes and is skipped. A long hold refuses with EBUSY, unless -d and the holder is a mount. With -d nothing else is checked (ENOTSUP on pools older than user holds). Without -d, user holds refuse with EBUSY and clones with EEXIST. Properties: `userrefs`. |
| `destroy_snap` | Snapshot destroy | 0 | `sync` | `module/zfs/dsl_destroy.c` | `dsl_destroy_snapshot_sync`, `dsl_destroy_snapshot_sync_impl` | Destroys one snapshot record and moves its blocks on (detail: snapshot lifecycle graph, path destroy_snapshot). With -d, while user holds, clones or a long hold remain, it only sets defer_destroy. Afterwards it queues removal of the snapshot's volume device. Properties: `defer_destroy`. |
| `hold_sync` | User holds | 0 | `sync` | `module/zfs/dsl_userhold.c` | `dsl_dataset_user_release_sync` | Where a snapshot marked defer_destroy because of user holds is finally destroyed: zfs release of the last hold, on a snapshot with no clones and no long hold, runs the snapshot destroy in the same sync task. |
| `head_check` | File system destroy checks | 0 | `any` | `module/zfs/dsl_destroy.c` | `dsl_destroy_head_check`, `dsl_destroy_head_check_impl` | Runs in open context and again in syncing context. EBUSY when the dataset has a long hold (still mounted, an open volume, a send) or still has snapshots of its own; EEXIST when it has child datasets. A clone whose deferred origin would be destroyed with it is also refused while that origin snapshot has a long hold. |
| `destroy_head` | File system destroy | 0 | `sync` | `module/zfs/dsl_destroy.c` | `dsl_destroy_head_sync`, `dsl_destroy_head_sync_impl`, `dsl_destroy_head_begin_sync`, `dsl_async_dataset_destroy`, `dsl_async_clone_destroy`, `old_synchronous_dataset_destroy` | Destroys a head dataset (file system, volume or clone) in one sync task: drops its deadlist, hands its blocks to the clone livelist, the bptree or (old pools) frees them in this txg, removes the dataset and directory records, and, for a clone whose origin is marked defer_destroy and has no other clone or hold, destroys that origin snapshot too. Then it queues removal of the volume devices. |

### 8.5 Freeing (detail in the snapshot graph) (`free`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `deadlist_split` | Deadlist split and merge | 0 | `sync` | `module/zfs/dsl_deadlist.c` | `dsl_deadlist_move_bpobj`, `dsl_deadlist_merge` | Snapshot destroy on the deadlists: the part of the next dataset's deadlist that only the destroyed snapshot referenced is moved to the pool free list, and the destroyed snapshot's own deadlist is merged into the next one. See the snapshot lifecycle graph. |
| `free_bpobj` | Pool free list (dp_free_bpobj) | 0 | `sync` | `module/zfs/bpobj.c` | `bpobj_enqueue_subobj`, `bpobj_iterate` | The pool-wide list of blocks waiting to be freed in the background. A snapshot destroy only moves whole deadlist sub-lists here, so its txg does no per-block work. Counted in the freeing pool property. |
| `bptree` | Async-destroy queue (bptree) | 0 | `sync` | `module/zfs/bptree.c` | `bptree_add`, `bptree_iterate` | One entry per destroyed file system or volume: its root block pointer and the txg at or below which blocks still belong to an older snapshot. The background traversal frees the newer blocks. |
| `livelist_del` | Livelist delete thread | 0 | `thr` | `module/zfs/spa.c` | `spa_livelist_delete_cb` | The z_livelist_destroy zthr. A destroyed clone that kept a livelist is freed from that list, one sub-list at a time, without walking the clone's tree. |
| `async_destroy` | dsl_process_async_destroys() | 0 | `sync` | `module/zfs/dsl_scan.c` | `dsl_process_async_destroys`, `dsl_scan_free_block_cb`, `dsl_scan_async_block_should_pause` | Called from dsl_scan_sync() in sync pass 1 of every txg while frees are pending: first the pool free list, then the bptree. It stops for this txg when its block or time budget is used up, so a large destroy is spread over many txgs and the freeing property counts down. Tunables: `zfs_free_min_time_ms`, `zfs_async_block_max_blocks`. Properties: `freeing`. |
| `metaslab_free` | metaslab_free() | 0 | `sync` | `module/zfs/metaslab.c` | `metaslab_free` | Shared with the I/O flow graph. Records the freed segments in the metaslab. They become allocatable TXG_DEFER_SIZE (2) txgs later. |

### 8.6 Pool destroy (`pool`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `spa_export` | spa_export_common() | 0 | `syscall` | `module/zfs/spa.c` | `spa_destroy`, `spa_export_common` | spa_destroy() is spa_export_common() with POOL_STATE_DESTROYED. It suspends async tasks, waits for dirty data and closing datasets, refuses with EBUSY while anything still holds the pool, removes every volume device, stops initialize, trim and rebuild, sets the pool state and marks all labels dirty, then unloads the pool and forgets it. It frees no blocks and overwrites no data. |
| `spa_unload` | spa_unload() | 0 | `syscall` | `module/zfs/spa.c` | `spa_unload`, `txg_sync_stop`, `spa_deactivate` | Syncs the last txgs (up to the final txg set by spa_export_common()), stops the txg threads, waits for outstanding I/O and frees the in-memory vdev tree. |
| `cachefile` | Pool cache file (zpool.cache) | 0 | `syscall` | `module/zfs/spa_config.c` | `spa_write_cachefile`, `spa_remove` | Rewrites the cache file without the destroyed pool, so it is not imported at boot, and removes the pool from the kernel's namespace. |
| `uberblock` | Uberblock + label update | 1 | `sync` | `module/zfs/vdev_label.c` | `spa_sync_rewrite_vdev_config`, `vdev_config_sync`, `vdev_label_sync`, `spa_config_generate` | Shared with the I/O flow graph. The end of every txg. With the configuration marked dirty, the labels of every leaf are rewritten from spa_config_generate(), which records the current pool state; this is how POOL_STATE_DESTROYED reaches the disks. |
| `dev_labels` | Labels L0-L3 + uberblock ring | 1 | `hw` | - | - | Shared with the I/O flow graph. After zpool destroy the four labels on every leaf still hold the full pool configuration, with pool_state destroyed (2), and the uberblock ring still points at intact data. |

## 9. Wires

76 wires. A wire runs from the node that hands something over to the node that receives it. `on paths` lists the section 10 paths that use the wire.

| wire | from | to | type | label | on paths |
|---|---|---|---|---|---|
| E001 | `zfs_cmd` | `snap_gather` | `ctl` | zfs destroy fs@spec: zfs_do_destroy() calls gather_snapshots(), which expands the spec with zfs_iter_snapspec_v2() and, with -r, repeats it for each descendant file system (zfs_iter_filesystems_v2()) | destroy_snapshot, destroy_batch, snap_refused, dry_run, defer_clone |
| E002 | `snap_gather` | `dep_walk` | `ctl` | snapshot_to_nvl_cb(): unless -R or -d, zfs_iter_dependents_v2() with destroy_check_dependent() looks for clones of each snapshot before it is added to the list | destroy_snapshot, destroy_batch, snap_refused, dry_run |
| E003 | `dep_walk` | `zfs_cmd` | `ctl` | refused before any ioctl: destroy_check_dependent() prints "has children" (child datasets or snapshots, needs -r) or "has dependent clones" (needs -R) and sets cb_error, and zfs_do_destroy() stops | snap_refused, fs_refused |
| E004 | `snap_gather` | `dry_run` | `ctl` | -v: destroy_print_snapshots() walks the file system's snapshots in creation order (zfs_iter_snapshots_sorted_v2()), prints "would destroy" or "will destroy" and groups the selected ones into contiguous ranges | dry_run |
| E005 | `dry_run` | `zfs_ioctl` | `ctl` | for each range: lzc_snaprange_space(first, last) -> ZFS_IOC_SPACE_SNAPS -> zfs_ioc_space_snaps() | dry_run |
| E006 | `zfs_ioctl` | `space_est` | `ctl` | zfs_ioc_space_snaps() takes a pool hold (dsl_pool_hold()), not a sync task, and calls dsl_dataset_space_wouldfree(first, last) | dry_run |
| E007 | `space_est` | `dry_run` | `ctl` | from the snapshot after last back to the one after first (ds_next_snap_obj), dsl_deadlist_space_range() sums the deadlist space born after first's ds_prev_snap_txg; the ranges add up in cb_snapused | dry_run |
| E008 | `dry_run` | `zfs_cmd` | `ctl` | zfs_do_destroy() prints "would reclaim" (-n) or "will reclaim"; with -n (cb_dryrun) it stops here and sends no destroy request | dry_run |
| E009 | `zfs_cmd` | `libzfs` | `ctl` | zfs_destroy_snaps_nvl(cb_nvl, defer): every gathered snapshot, of every file system with -r, in one request; lzc_destroy_snaps() adds "defer" for -d | destroy_snapshot, destroy_batch, snap_refused, defer_clone |
| E010 | `libzfs` | `zfs_ioctl` | `ctl` | lzc_destroy_snaps(): ZFS_IOC_DESTROY_SNAPS -> zfs_ioc_destroy_snaps() | destroy_snapshot, destroy_batch, snap_refused, destroy_recursive, defer_clone |
| E011 | `zfs_ioctl` | `snap_umount` | `ctl` | for each name: EXDEV if it is not in this pool; zfs_unmount_snap() -> zfsctl_snapshot_unmount() unmounts an automounted .zfs/snapshot mount | destroy_snapshot, destroy_batch, snap_refused |
| E012 | `snap_umount` | `long_holds` | `ctl` | zfsctl_snapshot_unmount_wait() waits up to about 40 ms (MSEC_TO_TICK(40)) for the snapshot to lose its long hold (dsl_dataset_long_held()); if it is still busy the destroy goes on and the check decides | destroy_snapshot |
| E013 | `zfs_ioctl` | `zvol_minors` | `ctl` | zvol_remove_minors(spa, snapshot, async): the snapshot's volume device, if any, is removed on the zvol taskq (taskq_dispatch()) | destroy_snapshot, destroy_batch |
| E014 | `zfs_ioctl` | `dsl_entry` | `ctl` | zfs_ioc_destroy_snaps() -> dsl_destroy_snapshots_nvl(snaps, defer, errlist) | destroy_snapshot, destroy_batch, snap_refused, destroy_recursive, defer_clone |
| E015 | `dsl_entry` | `sync_task` | `ctl` | one dsl_sync_task(dsl_destroy_snapshot_check, dsl_destroy_snapshot_sync) per snapshot, with ZFS_SPACE_CHECK_DESTROY; the first error is put in errlist (fnvlist_add_int32()) and ends the loop | destroy_snapshot, destroy_batch, snap_refused, destroy_recursive, defer_clone |
| E016 | `sync_task` | `snap_check` | `ctl` | dsl_sync_task_common(): the check runs first in open context (dst_checkfunc, pool config lock as reader); an error returns at once, before any txg | destroy_snapshot, destroy_batch, snap_refused, defer_clone |
| E017 | `snap_check` | `libzfs` | `ctl` | refused: user holds (ds_userrefs > 0) give EBUSY, clones (ds_num_children > 1) EEXIST; the error comes back in errlist (fnvlist_add_int32()) and zfs_destroy_snaps_nvl() prints "snapshot is cloned" or, after lzc_get_holds(), "it's being held" | destroy_batch, snap_refused |
| E018 | `sync_task` | `txg_sync` | `tx` | dmu_tx_assign() joins the open txg, the task is queued on dp_sync_tasks (txg_list_add_tail()), and txg_wait_synced() sleeps until that txg is on disk | destroy_snapshot, destroy_batch, snap_refused, destroy_filesystem, destroy_recursive, defer_clone |
| E019 | `txg_sync` | `spa_sync` | `tx` | txg_sync_thread() -> spa_sync(txg) | destroy_snapshot, destroy_batch, snap_refused, destroy_filesystem, destroy_recursive, defer_clone, zpool_destroy |
| E020 | `spa_sync` | `dsl_pool_sync` | `tx` | spa_sync_iterate_to_convergence(): dsl_pool_sync() in every pass | destroy_snapshot, destroy_batch, snap_refused, destroy_filesystem, destroy_recursive, defer_clone |
| E021 | `dsl_pool_sync` | `snap_check` | `ctl` | sync pass 1, after the dirty datasets are written: dsl_sync_task_sync() checks pool space (ENOSPC) and re-runs dsl_destroy_snapshot_check() (dst_checkfunc) with the config lock held as writer | destroy_snapshot, destroy_batch, snap_refused, destroy_recursive, defer_clone |
| E022 | `snap_check` | `long_holds` | `ctl` | dsl_destroy_snapshot_check_impl(): a long hold (dsl_dataset_long_held()) refuses with EBUSY, unless -d and the holder is a mount (dsl_dataset_has_owner()) | destroy_snapshot |
| E023 | `snap_check` | `destroy_snap` | `ctl` | the check passed: dst_syncfunc -> dsl_destroy_snapshot_sync() -> dsl_destroy_snapshot_sync_impl() | destroy_snapshot, destroy_batch, snap_refused, destroy_recursive, defer_clone |
| E024 | `destroy_snap` | `hold_sync` | `ctl` | -d while user holds (ds_userrefs), clones (ds_num_children > 1) or a long hold remain: only DS_FLAG_DEFER_DESTROY is set and nothing is freed; a mount that lets go triggers a later sweep (SPA_ASYNC_DEFER_DESTROY), the last release destroys it in its own sync task | snap_refused, defer_clone |
| E025 | `destroy_snap` | `deadlist_split` | `bp` | dsl_destroy_snapshot_sync_impl(): the next dataset's deadlist is split at this snapshot's previous-snapshot txg (dsl_deadlist_move_bpobj()) and this snapshot's deadlist is merged into it (dsl_deadlist_merge()) | destroy_snapshot, destroy_batch, destroy_recursive, defer_clone |
| E026 | `deadlist_split` | `free_bpobj` | `bp` | blocks only this snapshot referenced move whole to the pool free list (bpobj_enqueue_subobj()); freeing grows (dp_free_dir) | destroy_snapshot, destroy_batch, destroy_recursive, defer_clone |
| E027 | `destroy_snap` | `zvol_minors` | `ctl` | dsl_destroy_snapshot_sync(): zvol_remove_minors(snapshot name, async) after the record is gone | destroy_snapshot |
| E028 | `spa_sync` | `async_destroy` | `ctl` | in the next txgs: spa_sync_iterate_to_convergence() -> dsl_scan_sync(), which calls dsl_process_async_destroys() while frees are pending | destroy_snapshot, destroy_filesystem |
| E029 | `free_bpobj` | `async_destroy` | `bp` | bpobj_iterate(dp_free_bpobj): entries are freed and removed from the list | destroy_snapshot |
| E030 | `async_destroy` | `metaslab_free` | `alloc` | dsl_scan_free_block_cb() -> zio_free_sync() -> metaslab_free() for an ordinary block, and freeing shrinks (dp_free_dir); gang, dedup and cloned blocks take a free zio (snapshot graph) | destroy_snapshot, destroy_filesystem |
| E031 | `async_destroy` | `spa_sync` | `ctl` | dsl_scan_async_block_should_pause(): past zfs_async_block_max_blocks, or past zfs_free_min_time_ms (scn_async_block_min_time_ms) while a sync is waiting, it returns ERESTART and the rest waits for the next txg | destroy_snapshot, destroy_filesystem |
| E032 | `zfs_cmd` | `dep_walk` | `ctl` | zfs destroy fs: unless -R, zfs_iter_dependents_v2() with destroy_check_dependent() checks for children and snapshots (allowed with -r) and for clones outside the tree (allowed with -R) | destroy_filesystem, fs_refused, defer_clone |
| E033 | `zfs_cmd` | `dep_walk` | `ctl` | zfs_iter_dependents_v2(target, destroy_callback) walks every dependent depth first: child file systems (zfs_iter_filesystems_v2()), then snapshots in creation order (zfs_iter_snapshots_sorted_v2()), each after its clones (zfs_iter_clones()); for fs@snap -R, destroy_clones() does the same for each snapshot | destroy_filesystem, fs_refused, destroy_recursive |
| E034 | `dep_walk` | `zfs_cmd` | `ctl` | iter_dependents_cb() calls destroy_callback() for each dependent after its own dependents; zfs_do_destroy() then calls destroy_callback() for the target itself | destroy_filesystem, fs_refused, destroy_recursive |
| E035 | `zfs_cmd` | `libzfs` | `ctl` | destroy_callback(): a snapshot is only added to cb_batchedsnaps; a file system first flushes the batch, destroy_batched() -> zfs_destroy_snaps_nvl() | destroy_recursive |
| E036 | `zfs_cmd` | `mount_lib` | `ctl` | destroy_callback() -> zfs_unmount(dataset, MS_FORCE with -f): if it is mounted (libzfs_mnttab_find()), zfs_unshare() and zfs_commit_shares(), then unmount_one() | destroy_filesystem, fs_refused, destroy_recursive, defer_clone |
| E037 | `mount_lib` | `vfs_umount` | `ctl` | do_unmount(): umount2(mountpoint, flags), or /bin/umount when ZFS_MOUNT_HELPER is set; the kernel ends in zpl_put_super() -> zfs_umount() | destroy_filesystem, fs_refused, destroy_recursive, zpool_destroy |
| E038 | `vfs_umount` | `long_holds` | `ctl` | zfs_umount(): zfsvfs_teardown(), then dmu_objset_disown() -> dsl_dataset_disown() -> dsl_dataset_long_rele(): the mount's long hold is gone | destroy_filesystem |
| E039 | `mount_lib` | `zfs_cmd` | `ctl` | the unmount fails (EBUSY: a file open or a working directory inside, without -f): unmount_one() reports "cannot unmount", zfs_share() shares it again, nothing is destroyed; with -r cb_error is set and the walk continues | fs_refused |
| E040 | `zfs_cmd` | `libzfs` | `ctl` | zfs_destroy(dataset, no defer) -> lzc_destroy(name) | destroy_filesystem, fs_refused, destroy_recursive, defer_clone |
| E041 | `libzfs` | `zfs_ioctl` | `ctl` | lzc_destroy(): ZFS_IOC_DESTROY -> zfs_ioc_destroy() | destroy_filesystem, fs_refused, destroy_recursive, defer_clone |
| E042 | `zfs_ioctl` | `dsl_entry` | `ctl` | zfs_ioc_destroy() -> dsl_destroy_head(name); on EEXIST it destroys a hidden child name/%recv (recv_clone_name) left by an interrupted receive and tries again | destroy_filesystem, fs_refused, destroy_recursive, defer_clone |
| E043 | `dsl_entry` | `snap_umount` | `ctl` | dsl_destroy_head() -> zfs_destroy_unmount_origin(): for a clone whose origin snapshot is marked defer_destroy (DS_IS_DEFER_DESTROY()), that origin is unmounted (zfs_unmount_snap()), since it may be destroyed with the clone | defer_clone |
| E044 | `dsl_entry` | `prefree` | `ctl` | pool without async_destroy: a first sync task (dsl_destroy_head_begin_sync()) sets DS_FLAG_INCONSISTENT; then dmu_free_long_object() frees each object changed since the last snapshot from open context and txg_wait_synced() pushes the frees out | destroy_filesystem |
| E045 | `dsl_entry` | `sync_task` | `ctl` | dsl_sync_task(dsl_destroy_head_check, dsl_destroy_head_sync, ZFS_SPACE_CHECK_DESTROY) | destroy_filesystem, fs_refused, destroy_recursive, defer_clone |
| E046 | `sync_task` | `head_check` | `ctl` | dsl_sync_task_common(): dsl_destroy_head_check() runs first in open context (dst_checkfunc); an error returns at once, before any txg | destroy_filesystem, fs_refused, destroy_recursive |
| E047 | `dsl_pool_sync` | `head_check` | `ctl` | sync pass 1: dsl_sync_task_sync() checks pool space and re-runs dsl_destroy_head_check() (dst_checkfunc) with the config lock held as writer | destroy_filesystem, destroy_recursive, defer_clone |
| E048 | `head_check` | `long_holds` | `ctl` | dsl_destroy_head_check_impl(): the long hold count (ds_longholds) must be zero; a mount that is still there or an open volume gives EBUSY | destroy_filesystem, fs_refused |
| E049 | `head_check` | `libzfs` | `ctl` | refused: EBUSY for a long hold or for snapshots of its own (ds_next_snap_obj), EEXIST for child datasets (dd_child_dir_zapobj); zfs_destroy() prints "cannot destroy" | fs_refused |
| E050 | `head_check` | `destroy_head` | `ctl` | the check passed: dst_syncfunc -> dsl_destroy_head_sync() -> dsl_destroy_head_sync_impl() | destroy_filesystem, destroy_recursive, defer_clone |
| E051 | `destroy_head` | `bptree` | `bp` | async_destroy enabled (normal): dsl_async_dataset_destroy() -> bptree_add(root block pointer, ds_prev_snap_txg); the dataset's space moves to freeing (dp_free_dir) | destroy_filesystem, destroy_recursive |
| E052 | `destroy_head` | `livelist_del` | `bp` | a clone with an open livelist: dsl_async_clone_destroy() adds the livelist to the pool's deleted-clones ZAP (zap_add_int()) and wakes the delete thread (zthr_wakeup()) | destroy_recursive, defer_clone |
| E053 | `destroy_head` | `metaslab_free` | `bp` | pool without async_destroy: old_synchronous_dataset_destroy() -> traverse_dataset() -> kill_blkptr() -> dsl_dataset_block_kill() frees every block born after ds_prev_snap_txg in this txg | destroy_filesystem |
| E054 | `destroy_head` | `zvol_minors` | `ctl` | dsl_destroy_head_sync(): zvol_remove_minors(name, async): the volume's device and those of its snapshots go away | destroy_filesystem |
| E055 | `destroy_head` | `destroy_snap` | `ctl` | rmorigin: the clone's origin is marked defer_destroy, has no user holds and no other clone, so dsl_destroy_snapshot_sync_impl() destroys it in the same sync task | defer_clone |
| E056 | `bptree` | `async_destroy` | `bp` | after the free list: bptree_iterate() -> traverse_dataset_destroyed() frees the blocks born after each entry's txg, a slice per txg | destroy_filesystem |
| E057 | `livelist_del` | `metaslab_free` | `alloc` | spa_livelist_delete_cb(): dsl_process_sub_livelist() keeps the ALLOC entries of one sub-list without a matching FREE, and a sync task (dsl_sync_task()) frees them (zio_free()) | destroy_recursive, defer_clone |
| E058 | `libzfs` | `mount_lib` | `ctl` | zfs_destroy() succeeded: remove_mountpoint() removes the mountpoint directory (rmdir()) if the mountpoint is default or inherited (ZPROP_SRC_DEFAULT) | destroy_filesystem |
| E059 | `zpool_cmd` | `mount_lib` | `ctl` | zpool destroy [-f]: zpool_disable_datasets() reads the mount table (getmntent()), unshares every file system of the pool (unshare_one()), unmounts them in reverse mountpoint order, children first (qsort(), unmount_one()), and removes their mountpoint directories | zpool_destroy |
| E060 | `mount_lib` | `zpool_cmd` | `ctl` | an unmount fails: "could not unmount datasets", the pool is left as it was | zpool_destroy |
| E061 | `zpool_cmd` | `libzfs` | `ctl` | zpool_destroy(pool, history): ZFS_IOC_POOL_DESTROY | zpool_destroy |
| E062 | `libzfs` | `zfs_ioctl` | `ctl` | ZFS_IOC_POOL_DESTROY -> zfs_ioc_pool_destroy(): zfs_log_history() records the command, then spa_destroy() | zpool_destroy |
| E063 | `zfs_ioctl` | `spa_export` | `ctl` | spa_destroy() -> spa_export_common(pool, POOL_STATE_DESTROYED, no force, no hardforce) | zpool_destroy |
| E064 | `spa_export` | `txg_sync` | `tx` | spa_async_suspend(); txg_wait_synced() so dirty objsets close, and spa_evicting_os_wait() for datasets still being evicted | zpool_destroy |
| E065 | `spa_export` | `libzfs` | `ctl` | spa_refcount_zero() is false: something still holds the pool (an open volume takes spa_open_ref(), so does every held dataset directory), EBUSY, the pool stays imported | zpool_destroy |
| E066 | `spa_export` | `zvol_minors` | `ctl` | zvol_remove_minors(pool, async) and taskq_wait(): every volume device of the pool is gone before the pool is unloaded | zpool_destroy |
| E067 | `spa_export` | `uberblock` | `cfg` | vdev_initialize_stop_all() and the other stops, then spa_state = new_state (POOL_STATE_DESTROYED) and vdev_config_dirty(root vdev), so the next txgs rewrite every label; spa_final_txg = last synced txg + TXG_DEFER_SIZE + 1 | zpool_destroy |
| E068 | `spa_export` | `spa_unload` | `ctl` | sysevent ESC_ZFS_POOL_DESTROY, then spa_unload() and spa_deactivate() | zpool_destroy |
| E069 | `spa_unload` | `txg_sync` | `tx` | txg_sync_stop(): txg_wait_synced(open txg + TXG_DEFER_SIZE) syncs the final txgs, then the sync threads exit | zpool_destroy |
| E070 | `spa_sync` | `uberblock` | `cfg` | every txg ends in spa_sync_rewrite_vdev_config(); with the config dirty (spa_config_dirty_list), vdev_config_sync() writes the labels of all top-level vdevs | zpool_destroy |
| E071 | `uberblock` | `dev_labels` | `cfg` | vdev_label_sync(): the label nvlist from spa_config_generate() carries ZPOOL_CONFIG_POOL_STATE = destroyed; vdev_label_write() writes it to the label copies; the data is not touched | zpool_destroy |
| E072 | `spa_export` | `cachefile` | `cfg` | spa_write_cachefile(removing): the pool's entry is left out of zpool.cache, then spa_remove() drops the pool from the namespace | zpool_destroy |
| E073 | `libzfs` | `mount_lib` | `ctl` | zpool_destroy() succeeded: remove_mountpoint() of the pool's root file system | zpool_destroy |
| E074 | `zpool_cmd` | `dev_labels` | `cfg` | later, zpool import -D (do_destroyed): import_pools() keeps only pools whose label pool_state is POOL_STATE_DESTROYED; one last used by another host needs -f (zfs_force_import_required()) | zpool_destroy |
| E075 | `admin` | `zfs_cmd` | `ctl` | runs zfs destroy [-r] [-R] [-f] [-d] [-n] [-v] on a snapshot, snapshot range, file system or volume | destroy_snapshot, destroy_batch, snap_refused, dry_run, destroy_filesystem, fs_refused, destroy_recursive, defer_clone |
| E076 | `admin` | `zpool_cmd` | `ctl` | runs zpool destroy [-f] pool | zpool_destroy |

## 10. Paths

9 named paths, 207 steps in total. Each step is one wire; the caption for a step is that wire's label. Every wire in section 9 is on at least one path. Path syntax and alternatives are as in section 10 of `../zfs-io-flow-diagram-spec.md`.

### 10.1 `destroy_snapshot` - Destroy one snapshot

Category: Snapshot. zfs destroy pool/fs@snap, from the command line to the sync task that removes the record, and on to the background freeing that returns its unique space. The block-level detail is in `zfs-snapshot-lifecycle:destroy_snapshot`.

```
 1  E075  admin -> zfs_cmd
 2  E001  zfs_cmd -> snap_gather
 3  E002  snap_gather -> dep_walk  "no clones: the snapshot goes into the list"
 4  E009  zfs_cmd -> libzfs
 5  E010  libzfs -> zfs_ioctl
 6  E011  zfs_ioctl -> snap_umount
 7  E012  snap_umount -> long_holds
 8  E013  zfs_ioctl -> zvol_minors
 9  E014  zfs_ioctl -> dsl_entry
10  E015  dsl_entry -> sync_task
11  E016  sync_task -> snap_check
12  E018  sync_task -> txg_sync
13  E019  txg_sync -> spa_sync
14  E020  spa_sync -> dsl_pool_sync
15  E021  dsl_pool_sync -> snap_check
16  E022  snap_check -> long_holds  "no long hold"
17  E023  snap_check -> destroy_snap
18  E025  destroy_snap -> deadlist_split
19  E026  deadlist_split -> free_bpobj
20  E027  destroy_snap -> zvol_minors
21  E028  spa_sync -> async_destroy  "the command has already returned"
22  E029  free_bpobj -> async_destroy
23  E030  async_destroy -> metaslab_free
24  E031  async_destroy -> spa_sync  "large frees continue over several txgs"
```
Ends: The snapshot is gone when the command returns. Its unique blocks are freed in the following txgs (see `zfs-snapshot-lifecycle:free_drain`); the pool property freeing shows what is left, and the space is allocatable two txgs after it is freed.

### 10.2 `destroy_batch` - Snapshot range or -r: one request, one sync task per snapshot

Category: Snapshot. zfs destroy -r pool/fs@a%c collects every matching snapshot of fs and its descendants into one nvlist and one ioctl. The kernel still destroys them one sync task at a time, each waiting for its txg, so the request is not atomic: if a later snapshot is refused, the earlier ones stay destroyed.

Alternatives:
- `outcome`: `ok` Every snapshot can be destroyed; `fail` The second snapshot has a user hold

```
 1  E075  admin -> zfs_cmd
 2  E001  zfs_cmd -> snap_gather  "with -r the spec is applied to every descendant"
 3  E002  snap_gather -> dep_walk
 4  E009  zfs_cmd -> libzfs  "one nvlist with every snapshot"
 5  E010  libzfs -> zfs_ioctl
 6  E011  zfs_ioctl -> snap_umount  "every name is unmounted first"
 7  E013  zfs_ioctl -> zvol_minors
 8  E014  zfs_ioctl -> dsl_entry
 9  E015  dsl_entry -> sync_task  "snapshot 1"
10  E016  sync_task -> snap_check
11  E018  sync_task -> txg_sync
12  E019  txg_sync -> spa_sync
13  E020  spa_sync -> dsl_pool_sync
14  E021  dsl_pool_sync -> snap_check
15  E023  snap_check -> destroy_snap
16  E025  destroy_snap -> deadlist_split
17  E026  deadlist_split -> free_bpobj
18  E015  dsl_entry -> sync_task  "snapshot 2: a new sync task, after snapshot 1's txg is on disk"
19  E016  sync_task -> snap_check
20  E017  snap_check -> libzfs  [outcome: fail]  "snapshot 1 is already destroyed; the rest of the list is not tried"
21  E018  sync_task -> txg_sync  [outcome: ok]
22  E019  txg_sync -> spa_sync  [outcome: ok]
23  E020  spa_sync -> dsl_pool_sync  [outcome: ok]
24  E021  dsl_pool_sync -> snap_check  [outcome: ok]
25  E023  snap_check -> destroy_snap  [outcome: ok]
26  E025  destroy_snap -> deadlist_split  [outcome: ok]
27  E026  deadlist_split -> free_bpobj  [outcome: ok]  "and so on for each further snapshot"
```
Ends: With `ok` every snapshot is gone, one txg each, and their blocks wait on the pool free list (`zfs-snapshot-lifecycle:free_drain`). With `fail` the command reports the held snapshot, and the snapshots before it in the list are destroyed.

### 10.3 `snap_refused` - Refused: a clone or a hold, and -d instead

Category: Snapshot. Why a snapshot destroy is refused, and what -d does instead. A clone is caught by zfs(8) before any request is sent; a user hold is caught by the kernel's open-context check, before any txg; with -d both checks are skipped and the snapshot is only marked.

Alternatives:
- `case`: `clone` The snapshot has a clone; `hold` The snapshot has a user hold; `defer` zfs destroy -d on a held or cloned snapshot

```
 1  E075  admin -> zfs_cmd
 2  E001  zfs_cmd -> snap_gather
 3  E002  snap_gather -> dep_walk  [case: clone, hold]  "skipped with -d"
 4  E003  dep_walk -> zfs_cmd  [case: clone]  "has dependent clones: use -R, or -d"
 5  E009  zfs_cmd -> libzfs  [case: hold, defer]
 6  E010  libzfs -> zfs_ioctl  [case: hold, defer]
 7  E011  zfs_ioctl -> snap_umount  [case: hold, defer]
 8  E014  zfs_ioctl -> dsl_entry  [case: hold, defer]
 9  E015  dsl_entry -> sync_task  [case: hold, defer]
10  E016  sync_task -> snap_check  [case: hold, defer]
11  E017  snap_check -> libzfs  [case: hold]  "EBUSY: run zfs holds -r to see the tags"
12  E018  sync_task -> txg_sync  [case: defer]
13  E019  txg_sync -> spa_sync  [case: defer]
14  E020  spa_sync -> dsl_pool_sync  [case: defer]
15  E021  dsl_pool_sync -> snap_check  [case: defer]  "with -d holds and clones are not checked"
16  E023  snap_check -> destroy_snap  [case: defer]
17  E024  destroy_snap -> hold_sync  [case: defer]  "defer_destroy=on; nothing is freed yet"
```
Ends: With `clone` and `hold` nothing has changed. With `defer` the snapshot stays, marked defer_destroy; it is destroyed by the last zfs release (`zfs-snapshot-lifecycle:holds_defer`) or together with its last clone (path defer_clone).

### 10.4 `dry_run` - Dry run with space estimate (zfs destroy -nv)

Category: Snapshot. zfs destroy -nv pool/fs@a%c lists what would be destroyed and how much space that would free, without changing anything.

```
 1  E075  admin -> zfs_cmd
 2  E001  zfs_cmd -> snap_gather
 3  E002  snap_gather -> dep_walk
 4  E004  snap_gather -> dry_run
 5  E005  dry_run -> zfs_ioctl
 6  E006  zfs_ioctl -> space_est
 7  E007  space_est -> dry_run
 8  E008  dry_run -> zfs_cmd  "-n: stop here"
```
Ends: Nothing has changed. The estimate is what destroying exactly these snapshots would free at this moment; blocks also held by snapshots outside the list are not counted, and a later destroy of those snapshots can free more. Without -n, -v prints the same and then destroys (path destroy_batch).

### 10.5 `destroy_filesystem` - Destroy a file system or a volume

Category: Dataset. zfs destroy pool/fs, for a file system or volume without children or snapshots: the dependency check, the unmount, one sync task, and the background freeing. The block-level detail is in `zfs-snapshot-lifecycle:destroy_filesystem`.

Alternatives:
- `type`: `fs` File system (mounted); `vol` Volume (not open)
- `method`: `bptree` Pool with async_destroy (normal); `old` Pool without async_destroy

```
 1  E075  admin -> zfs_cmd
 2  E032  zfs_cmd -> dep_walk  "no children, snapshots or clones"
 3  E033  zfs_cmd -> dep_walk
 4  E034  dep_walk -> zfs_cmd  "no dependents: only the target itself"
 5  E036  zfs_cmd -> mount_lib  [type: fs]
 6  E037  mount_lib -> vfs_umount  [type: fs]
 7  E038  vfs_umount -> long_holds  [type: fs]
 8  E040  zfs_cmd -> libzfs
 9  E041  libzfs -> zfs_ioctl
10  E042  zfs_ioctl -> dsl_entry
11  E044  dsl_entry -> prefree  [method: old]
12  E045  dsl_entry -> sync_task
13  E046  sync_task -> head_check
14  E018  sync_task -> txg_sync
15  E019  txg_sync -> spa_sync
16  E020  spa_sync -> dsl_pool_sync
17  E047  dsl_pool_sync -> head_check
18  E048  head_check -> long_holds  "no mount and no open volume left"
19  E050  head_check -> destroy_head
20  E051  destroy_head -> bptree  [method: bptree]
21  E053  destroy_head -> metaslab_free  [method: old]  "the whole tree in this one txg"
22  E054  destroy_head -> zvol_minors  [type: vol]
23  E058  libzfs -> mount_lib  [type: fs]
24  E028  spa_sync -> async_destroy  [method: bptree]  "the command has already returned"
25  E056  bptree -> async_destroy  [method: bptree]
26  E030  async_destroy -> metaslab_free  [method: bptree]
27  E031  async_destroy -> spa_sync  [method: bptree]
```
Ends: The dataset is gone after one txg (two, plus the pre-free, on old pools). With async_destroy its blocks come back over the following txgs while freeing counts down.

### 10.6 `fs_refused` - Refused: children, clones or busy

Category: Dataset. The reasons zfs destroy pool/fs stops. Children, snapshots and outside clones are found by zfs(8) before anything changes; a file system in use fails to unmount; a volume that is open (or any other long hold) is refused by the kernel check.

Alternatives:
- `case`: `children` Has child datasets or snapshots, no -r; `clones` -r, but a snapshot has a clone outside the tree; `busy` Mounted file system in use; `held` Open volume

```
 1  E075  admin -> zfs_cmd
 2  E032  zfs_cmd -> dep_walk
 3  E003  dep_walk -> zfs_cmd  [case: children, clones]  "the message says use -r or use -R and lists the datasets"
 4  E033  zfs_cmd -> dep_walk  [case: busy, held]
 5  E034  dep_walk -> zfs_cmd  [case: busy, held]
 6  E036  zfs_cmd -> mount_lib  [case: busy]
 7  E037  mount_lib -> vfs_umount  [case: busy]  "umount2() fails with EBUSY"
 8  E039  mount_lib -> zfs_cmd  [case: busy]  "-f forces the unmount"
 9  E040  zfs_cmd -> libzfs  [case: held]  "a volume has nothing to unmount"
10  E041  libzfs -> zfs_ioctl  [case: held]
11  E042  zfs_ioctl -> dsl_entry  [case: held]
12  E045  dsl_entry -> sync_task  [case: held]
13  E046  sync_task -> head_check  [case: held]
14  E048  head_check -> long_holds  [case: held]  "the open volume owns the dataset"
15  E049  head_check -> libzfs  [case: held]  "EBUSY: dataset is busy"
```
Ends: Nothing is destroyed. Close the files or the volume, or use -r, -R or -f as the message says.

### 10.7 `destroy_recursive` - zfs destroy -R: descendants and clones, in order

Category: Dataset. zfs destroy -R pool/fs, where fs has a snapshot fs@s1 that is the origin of a clone pool/c elsewhere in the pool. zfs(8) destroys the clone first, then the batched snapshot, then fs itself. Each file system or volume is its own ioctl and its own txg.

```
 1  E075  admin -> zfs_cmd
 2  E033  zfs_cmd -> dep_walk  "-R skips the dependency check"
 3  E034  dep_walk -> zfs_cmd  "first the clone pool/c, reached through fs@s1"
 4  E036  zfs_cmd -> mount_lib  "unmount pool/c"
 5  E037  mount_lib -> vfs_umount
 6  E040  zfs_cmd -> libzfs  "destroy pool/c"
 7  E041  libzfs -> zfs_ioctl
 8  E042  zfs_ioctl -> dsl_entry
 9  E045  dsl_entry -> sync_task
10  E046  sync_task -> head_check
11  E018  sync_task -> txg_sync
12  E019  txg_sync -> spa_sync
13  E020  spa_sync -> dsl_pool_sync
14  E047  dsl_pool_sync -> head_check
15  E050  head_check -> destroy_head
16  E052  destroy_head -> livelist_del  "the clone's own blocks"
17  E057  livelist_del -> metaslab_free
18  E034  dep_walk -> zfs_cmd  "then fs@s1, which only joins the batch; then the target fs"
19  E035  zfs_cmd -> libzfs  "the batch is sent before fs is unmounted"
20  E010  libzfs -> zfs_ioctl
21  E014  zfs_ioctl -> dsl_entry
22  E015  dsl_entry -> sync_task
23  E018  sync_task -> txg_sync
24  E019  txg_sync -> spa_sync
25  E020  spa_sync -> dsl_pool_sync
26  E021  dsl_pool_sync -> snap_check  "no clone any more"
27  E023  snap_check -> destroy_snap
28  E025  destroy_snap -> deadlist_split
29  E026  deadlist_split -> free_bpobj
30  E036  zfs_cmd -> mount_lib  "unmount fs"
31  E040  zfs_cmd -> libzfs  "destroy fs"
32  E041  libzfs -> zfs_ioctl
33  E042  zfs_ioctl -> dsl_entry
34  E045  dsl_entry -> sync_task
35  E018  sync_task -> txg_sync
36  E019  txg_sync -> spa_sync
37  E020  spa_sync -> dsl_pool_sync
38  E047  dsl_pool_sync -> head_check
39  E050  head_check -> destroy_head
40  E051  destroy_head -> bptree
```
Ends: The clone, the snapshot and the file system are gone, in three requests and at least three txgs. Their blocks are freed in the background from the livelist, the pool free list and the bptree (`zfs-snapshot-lifecycle:destroy_filesystem`). With -r instead of -R the same command is refused, because the clone is outside pool/fs (path fs_refused).

### 10.8 `defer_clone` - zfs destroy -d on a cloned snapshot, then destroy the clone

Category: Snapshot. zfs destroy -d pool/fs@s1 while pool/c is a clone of it only marks the snapshot. Destroying the clone later takes the marked origin with it, in the same sync task.

```
 1  E075  admin -> zfs_cmd
 2  E001  zfs_cmd -> snap_gather  "zfs destroy -d pool/fs@s1"
 3  E009  zfs_cmd -> libzfs
 4  E010  libzfs -> zfs_ioctl
 5  E014  zfs_ioctl -> dsl_entry
 6  E015  dsl_entry -> sync_task
 7  E016  sync_task -> snap_check
 8  E018  sync_task -> txg_sync
 9  E019  txg_sync -> spa_sync
10  E020  spa_sync -> dsl_pool_sync
11  E021  dsl_pool_sync -> snap_check
12  E023  snap_check -> destroy_snap
13  E024  destroy_snap -> hold_sync  "the clone keeps it: only marked"
14  E032  zfs_cmd -> dep_walk  "later: zfs destroy pool/c"
15  E036  zfs_cmd -> mount_lib
16  E040  zfs_cmd -> libzfs
17  E041  libzfs -> zfs_ioctl
18  E042  zfs_ioctl -> dsl_entry
19  E043  dsl_entry -> snap_umount  "the marked origin may go too"
20  E045  dsl_entry -> sync_task
21  E018  sync_task -> txg_sync
22  E019  txg_sync -> spa_sync
23  E020  spa_sync -> dsl_pool_sync
24  E047  dsl_pool_sync -> head_check
25  E050  head_check -> destroy_head
26  E052  destroy_head -> livelist_del
27  E055  destroy_head -> destroy_snap
28  E025  destroy_snap -> deadlist_split
29  E026  deadlist_split -> free_bpobj
30  E057  livelist_del -> metaslab_free
```
Ends: The clone and its origin snapshot are both gone after one txg; their blocks are freed in the background (`zfs-snapshot-lifecycle:free_drain`).

### 10.9 `zpool_destroy` - zpool destroy, and the way back with import -D

Category: Pool. zpool destroy pool: every file system is unmounted, the kernel marks the pool destroyed in every label, syncs the final txgs and forgets the pool. No block is freed. zpool import -D can find it again later.

Alternatives:
- `outcome`: `ok` Destroyed; `busy` A file system cannot be unmounted; `held` A volume of the pool is open
- `later`: `none` Nothing more (no steps); `import` Later zpool import -D

```
 1  E076  admin -> zpool_cmd
 2  E059  zpool_cmd -> mount_lib
 3  E037  mount_lib -> vfs_umount  "for each mounted file system"
 4  E060  mount_lib -> zpool_cmd  [outcome: busy]
 5  E061  zpool_cmd -> libzfs  [outcome: ok, held]
 6  E062  libzfs -> zfs_ioctl  [outcome: ok, held]
 7  E063  zfs_ioctl -> spa_export  [outcome: ok, held]
 8  E064  spa_export -> txg_sync  [outcome: ok, held]
 9  E065  spa_export -> libzfs  [outcome: held]  "an open volume is not closed for you"
10  E066  spa_export -> zvol_minors  [outcome: ok]
11  E067  spa_export -> uberblock  [outcome: ok]
12  E068  spa_export -> spa_unload  [outcome: ok]
13  E069  spa_unload -> txg_sync  [outcome: ok]
14  E019  txg_sync -> spa_sync  [outcome: ok]
15  E070  spa_sync -> uberblock  [outcome: ok]
16  E071  uberblock -> dev_labels  [outcome: ok]
17  E072  spa_export -> cachefile  [outcome: ok]
18  E073  libzfs -> mount_lib  [outcome: ok]
19  E074  zpool_cmd -> dev_labels  [outcome: ok]  [later: import]  "the pool comes back with its data"
```
Ends: With `ok` the pool is gone from the system and from zpool.cache, but every disk still carries a complete pool marked destroyed. Creating a new pool on the disks or zpool labelclear makes that permanent. With `busy` or `held` the pool is still imported (its file systems may be partly unmounted with `held`).

## 11. Accuracy rules and known simplifications

Rules:

- Check everything against a checkout of the pinned commit (`../zfs`). The statements this graph rests on are: the per-snapshot `dsl_sync_task()` loop in `dsl_destroy_snapshots_nvl()` (dsl_destroy.c:622 to 640), which does not match the "none will be destroyed" wording of the comments above it and above `lzc_destroy_snaps()`; the post-order callback in `iter_dependents_cb()` (libzfs_iter.c:565); the batch flush before each file system in `destroy_callback()` (zfs_main.c:1532); and `spa_destroy()` being `spa_export_common(pool, POOL_STATE_DESTROYED, ...)` (spa.c:8177).
- Node ids shared with the I/O graph keep that graph's title and context; ids shared with the snapshot lifecycle and encryption graphs keep theirs.
- OS-specific pieces use Linux names (`zfsctl_snapshot_unmount()`, `zfs_umount()` from `zpl_put_super()`, `umount2()`).

Simplifications made on purpose. State these in the page's About overlay so nobody mistakes the diagram for the whole truth:

1. The block-level freeing is summarised in one column. Deadlist splitting, bptree traversal, livelists, free zios for gang, dedup and cloned blocks, and space accounting are drawn in the snapshot lifecycle graph.
2. Recursive destroys are drawn with one clone and one snapshot. Real walks repeat the same steps per dataset; with -r an error on one dataset is reported and the walk continues.
3. The deferred-destroy sweep after a mounted snapshot is unmounted (`dsl_destroy_snapshot_deferred()` on the async thread) and the release of the last hold are not drawn here; see the snapshot lifecycle graph.
4. Bookmark destroy, channel-program destroys, `zfs destroy -p` output and the history and sysevent records are left out.
5. On a pool with a checkpoint, destroys free nothing until the checkpoint is discarded; this is not drawn.
6. Destroying an encryption root also destroys its key object and unloads its wrapping key (`dsl_dir_destroy_sync()`); zoned datasets are detached from their zone. Neither is drawn.
7. zpool destroy is drawn for an imported, healthy pool. Initialize, trim, rebuild and L2ARC rebuild stops, the ARC flush and log space map handling during unload are summarised.

## 12. Build order

See `../zfs-io-flow-diagram-spec.md` section 12 and `zfs-viewer-suite-spec.md`.

## 13. Acceptance checklist

- Counts: 36 nodes, 76 wires, 9 paths, 207 path steps, 6 groups, 5 wire types, 97 functions in the index, 203 wire references (Appendix C), 8 tunable and property references (Appendix D).
- Activating path `destroy_snapshot` highlights 24 distinct wires and plays 24 steps; `dry_run` highlights 8 and plays 8; `destroy_filesystem` with the default alternatives highlights 24 and plays 24.
- Choosing `outcome: fail` in path `destroy_batch` ends the second snapshot's sync task at the open-context check; choosing `case: defer` in `snap_refused` ends at the defer_destroy mark.
- Nodes `txg_sync`, `spa_sync`, `dsl_pool_sync`, `metaslab_free`, `uberblock` and `dev_labels` show "Also in: ZFS I/O Flow"; `zfs_cmd`, `sync_task`, `destroy_snap` and `destroy_head` show the snapshot lifecycle graph.
- Every `zfs-snapshot-lifecycle:` link in a path summary or "Ends" text opens that path.

## Appendix A. Function index

97 functions named in section 8, with file and line at commit `c913da8615`.

```
bpobj_enqueue_subobj  module/zfs/bpobj.c:663
bpobj_iterate  module/zfs/bpobj.c:534
bptree_add  module/zfs/bptree.c:110
bptree_iterate  module/zfs/bptree.c:180
destroy_batched  cmd/zfs/zfs_main.c:1473
destroy_callback  cmd/zfs/zfs_main.c:1483
destroy_check_dependent  cmd/zfs/zfs_main.c:1416
destroy_clones  cmd/zfs/zfs_main.c:1669
destroy_print_cb  cmd/zfs/zfs_main.c:1555
destroy_print_snapshots  cmd/zfs/zfs_main.c:1597
dmu_free_long_object  module/zfs/dmu.c:1322
dmu_object_next  module/zfs/dmu_object.c:381
dmu_objset_disown  module/zfs/dmu_objset.c:923
do_unmount  lib/libzfs/os/linux/libzfs_mount_os.c:373
dsl_async_clone_destroy  module/zfs/dsl_destroy.c:956
dsl_async_dataset_destroy  module/zfs/dsl_destroy.c:1015
dsl_dataset_disown  module/zfs/dsl_dataset.c:1033
dsl_dataset_has_owner  module/zfs/dsl_dataset.c:1079
dsl_dataset_long_hold  module/zfs/dsl_dataset.c:941
dsl_dataset_long_held  module/zfs/dsl_dataset.c:955
dsl_dataset_long_rele  module/zfs/dsl_dataset.c:948
dsl_dataset_space_wouldfree  module/zfs/dsl_dataset.c:5069
dsl_dataset_user_release_sync  module/zfs/dsl_userhold.c:522
dsl_deadlist_merge  module/zfs/dsl_deadlist.c:867
dsl_deadlist_move_bpobj  module/zfs/dsl_deadlist.c:931
dsl_deadlist_space_range  module/zfs/dsl_deadlist.c:764
dsl_destroy_head  module/zfs/dsl_destroy.c:1264
dsl_destroy_head_begin_sync  module/zfs/dsl_destroy.c:1247
dsl_destroy_head_check  module/zfs/dsl_destroy.c:866
dsl_destroy_head_check_impl  module/zfs/dsl_destroy.c:819
dsl_destroy_head_sync  module/zfs/dsl_destroy.c:1234
dsl_destroy_head_sync_impl  module/zfs/dsl_destroy.c:1064
dsl_destroy_inconsistent  module/zfs/dsl_destroy.c:1325
dsl_destroy_snapshot  module/zfs/dsl_destroy.c:645
dsl_destroy_snapshot_check  module/zfs/dsl_destroy.c:91
dsl_destroy_snapshot_check_impl  module/zfs/dsl_destroy.c:45
dsl_destroy_snapshot_sync  module/zfs/dsl_destroy.c:579
dsl_destroy_snapshot_sync_impl  module/zfs/dsl_destroy.c:307
dsl_destroy_snapshots_nvl  module/zfs/dsl_destroy.c:611
dsl_pool_sync  module/zfs/dsl_pool.c:700
dsl_process_async_destroys  module/zfs/dsl_scan.c:3972
dsl_scan_async_block_should_pause  module/zfs/dsl_scan.c:3712
dsl_scan_free_block_cb  module/zfs/dsl_scan.c:3751
dsl_sync_task  module/zfs/dsl_synctask.c:126
dsl_sync_task_common  module/zfs/dsl_synctask.c:34
dsl_sync_task_sync  module/zfs/dsl_synctask.c:207
gather_snapshots  cmd/zfs/zfs_main.c:1642
import_pools  cmd/zpool/zpool_main.c:3961
iter_dependents_cb  lib/libzfs/libzfs_iter.c:516
lzc_destroy  lib/libzfs_core/libzfs_core.c:375
lzc_destroy_snaps  lib/libzfs_core/libzfs_core.c:452
lzc_snaprange_space  lib/libzfs_core/libzfs_core.c:478
metaslab_free  module/zfs/metaslab.c:6216
old_synchronous_dataset_destroy  module/zfs/dsl_destroy.c:790
remove_mountpoint  lib/libzfs/libzfs_mount.c:897
snapshot_to_nvl_cb  cmd/zfs/zfs_main.c:1620
spa_config_generate  module/zfs/spa_config.c:314
spa_deactivate  module/zfs/spa.c:1941
spa_destroy  module/zfs/spa.c:8175
spa_export_common  module/zfs/spa.c:7957
spa_livelist_delete_cb  module/zfs/spa.c:3396
spa_remove  module/zfs/spa_misc.c:956
spa_sync  module/zfs/spa.c:11405
spa_sync_iterate_to_convergence  module/zfs/spa.c:11192
spa_sync_rewrite_vdev_config  module/zfs/spa.c:11355
spa_unload  module/zfs/spa.c:2317
spa_write_cachefile  module/zfs/spa_config.c:142
txg_sync_stop  module/zfs/txg.c:251
txg_sync_thread  module/zfs/txg.c:510
txg_wait_synced  module/zfs/txg.c:764
unmount_one  lib/libzfs/libzfs_mount.c:579
vdev_config_sync  module/zfs/vdev_label.c:2243
vdev_label_sync  module/zfs/vdev_label.c:2099
zfs_destroy  lib/libzfs/libzfs_dataset.c:3808
zfs_destroy_snaps_nvl  lib/libzfs/libzfs_dataset.c:3900
zfs_destroy_unmount_origin  module/zfs/zfs_ioctl.c:4369
zfs_do_destroy  cmd/zfs/zfs_main.c:1698
zfs_ioc_destroy  module/zfs/zfs_ioctl.c:4701
zfs_ioc_destroy_snaps  module/zfs/zfs_ioctl.c:4403
zfs_ioc_pool_destroy  module/zfs/zfs_ioctl.c:1783
zfs_ioc_space_snaps  module/zfs/zfs_ioctl.c:7322
zfs_iter_dependents_v2  lib/libzfs/libzfs_iter.c:580
zfs_iter_snapspec_v2  lib/libzfs/libzfs_iter.c:407
zfs_umount  module/os/linux/zfs/zfs_vfsops.c:1612
zfs_unmount  lib/libzfs/libzfs_mount.c:622
zfs_unmount_snap  module/zfs/zfs_ioctl.c:4347
zfs_unshare  lib/libzfs/libzfs_mount.c:837
zfsctl_snapshot_unmount  module/os/linux/zfs/zfs_ctldir.c:1392
zfsctl_snapshot_unmount_wait  module/os/linux/zfs/zfs_ctldir.c:1309
zfsvfs_teardown  module/os/linux/zfs/zfs_vfsops.c:1245
zpool_destroy  lib/libzfs/libzfs_pool.c:1825
zpool_disable_datasets  lib/libzfs/libzfs_mount.c:1388
zpool_do_destroy  cmd/zpool/zpool_main.c:2335
zpool_do_import  cmd/zpool/zpool_main.c:4360
zvol_remove_minors  module/zfs/zvol.c:2299
zvol_remove_minors_impl  module/zfs/zvol.c:1805
zvol_shutdown_minor  module/zfs/zvol.c:1760
```

## Appendix C. Wire source references

201 references for the 74 wires, at commit `c913da8615`. Each line is `<wire>  <file>:<line>  <symbol>`, and the symbol appears verbatim on that source line. A wire's references are listed in the order of the calls in its label.

```
E001  cmd/zfs/zfs_main.c:1772  gather_snapshots
E001  cmd/zfs/zfs_main.c:1647  zfs_iter_snapspec_v2
E001  cmd/zfs/zfs_main.c:1661  zfs_iter_filesystems_v2
E002  cmd/zfs/zfs_main.c:1629  zfs_iter_dependents_v2
E002  cmd/zfs/zfs_main.c:1630  destroy_check_dependent
E002  cmd/zfs/zfs_main.c:1634  nvlist_add_boolean
E003  cmd/zfs/zfs_main.c:1433  children
E003  cmd/zfs/zfs_main.c:1454  clones
E003  cmd/zfs/zfs_main.c:1439  cb_error
E003  cmd/zfs/zfs_main.c:1773  cb_error
E003  cmd/zfs/zfs_main.c:1902  cb_error
E004  cmd/zfs/zfs_main.c:1655  destroy_print_snapshots
E004  cmd/zfs/zfs_main.c:1602  zfs_iter_snapshots_sorted_v2
E005  cmd/zfs/zfs_main.c:1584  lzc_snaprange_space
E005  lib/libzfs_core/libzfs_core.c:497  ZFS_IOC_SPACE_SNAPS
E005  module/zfs/zfs_ioctl.c:8017  zfs_ioc_space_snaps
E006  module/zfs/zfs_ioctl.c:7332  dsl_pool_hold
E006  module/zfs/zfs_ioctl.c:7356  dsl_dataset_space_wouldfree
E007  module/zfs/dsl_dataset.c:5091  ds_next_snap_obj
E007  module/zfs/dsl_dataset.c:5100  dsl_deadlist_space_range
E007  module/zfs/dsl_dataset.c:5101  ds_prev_snap_txg
E007  cmd/zfs/zfs_main.c:1586  cb_snapused
E008  cmd/zfs/zfs_main.c:1792  reclaim
E008  cmd/zfs/zfs_main.c:1800  cb_dryrun
E009  cmd/zfs/zfs_main.c:1814  zfs_destroy_snaps_nvl
E009  lib/libzfs/libzfs_dataset.c:3909  lzc_destroy_snaps
E009  lib/libzfs_core/libzfs_core.c:469  defer
E010  lib/libzfs_core/libzfs_core.c:471  ZFS_IOC_DESTROY_SNAPS
E010  module/zfs/zfs_ioctl.c:8047  zfs_ioc_destroy_snaps
E011  module/zfs/zfs_ioctl.c:4425  EXDEV
E011  module/zfs/zfs_ioctl.c:4427  zfs_unmount_snap
E011  module/zfs/zfs_ioctl.c:4352  zfsctl_snapshot_unmount
E012  module/os/linux/zfs/zfs_ctldir.c:1495  zfsctl_snapshot_unmount_wait
E012  module/os/linux/zfs/zfs_ctldir.c:1316  MSEC_TO_TICK(40)
E012  module/os/linux/zfs/zfs_ctldir.c:1274  dsl_dataset_long_held
E013  module/zfs/zfs_ioctl.c:4429  zvol_remove_minors
E013  module/zfs/zvol.c:2308  taskq_dispatch
E014  module/zfs/zfs_ioctl.c:4434  dsl_destroy_snapshots_nvl
E015  module/zfs/dsl_destroy.c:626  dsl_sync_task
E015  module/zfs/dsl_destroy.c:628  ZFS_SPACE_CHECK_DESTROY
E015  module/zfs/dsl_destroy.c:635  fnvlist_add_int32
E016  module/zfs/dsl_synctask.c:63  dsl_pool_config_enter
E016  module/zfs/dsl_synctask.c:64  dst_checkfunc
E017  module/zfs/dsl_destroy.c:78  ds_userrefs
E017  module/zfs/dsl_destroy.c:84  ds_num_children
E017  module/zfs/dsl_destroy.c:635  fnvlist_add_int32
E017  lib/libzfs/libzfs_dataset.c:3933  cloned
E017  lib/libzfs/libzfs_dataset.c:3938  lzc_get_holds
E017  lib/libzfs/libzfs_dataset.c:3944  held
E018  module/zfs/dsl_synctask.c:51  dmu_tx_assign
E018  module/zfs/dsl_synctask.c:75  txg_list_add_tail
E018  module/zfs/dsl_synctask.c:91  txg_wait_synced
E019  module/zfs/txg.c:602  spa_sync
E020  module/zfs/spa.c:11208  dsl_pool_sync
E021  module/zfs/dsl_pool.c:876  dsl_sync_task_sync
E021  module/zfs/dsl_synctask.c:233  ENOSPC
E021  module/zfs/dsl_synctask.c:244  dst_checkfunc
E022  module/zfs/dsl_destroy.c:50  dsl_dataset_long_held
E022  module/zfs/dsl_destroy.c:59  dsl_dataset_has_owner
E023  module/zfs/dsl_synctask.c:246  dst_syncfunc
E023  module/zfs/dsl_destroy.c:592  dsl_destroy_snapshot_sync_impl
E024  module/zfs/dsl_destroy.c:321  ds_userrefs
E024  module/zfs/dsl_destroy.c:322  ds_num_children
E024  module/zfs/dsl_destroy.c:323  dsl_dataset_long_held
E024  module/zfs/dsl_destroy.c:326  DS_FLAG_DEFER_DESTROY
E024  module/zfs/dsl_destroy.c:338  SPA_ASYNC_DEFER_DESTROY
E024  module/zfs/dsl_userhold.c:544  dsl_destroy_snapshot_sync_impl
E025  module/zfs/dsl_destroy.c:424  dsl_deadlist_move_bpobj
E025  module/zfs/dsl_destroy.c:431  dsl_deadlist_merge
E026  module/zfs/dsl_deadlist.c:961  bpobj_enqueue_subobj
E026  module/zfs/dsl_destroy.c:427  dp_free_dir
E027  module/zfs/dsl_destroy.c:593  zvol_remove_minors
E028  module/zfs/spa.c:11231  dsl_scan_sync
E028  module/zfs/dsl_scan.c:4620  dsl_process_async_destroys
E029  module/zfs/dsl_scan.c:3987  bpobj_iterate
E030  module/zfs/dsl_scan.c:3761  zio_free_sync
E030  module/zfs/zio.c:1506  metaslab_free
E030  module/zfs/dsl_scan.c:3763  dp_free_dir
E031  module/zfs/dsl_scan.c:3720  zfs_async_block_max_blocks
E031  module/zfs/dsl_scan.c:3745  scn_async_block_min_time_ms
E031  module/zfs/dsl_scan.c:3758  ERESTART
E032  cmd/zfs/zfs_main.c:1896  zfs_iter_dependents_v2
E032  cmd/zfs/zfs_main.c:1897  destroy_check_dependent
E033  cmd/zfs/zfs_main.c:1907  zfs_iter_dependents_v2
E033  lib/libzfs/libzfs_iter.c:556  zfs_iter_filesystems_v2
E033  lib/libzfs/libzfs_iter.c:559  zfs_iter_snapshots_sorted_v2
E033  lib/libzfs/libzfs_iter.c:524  zfs_iter_clones
E033  cmd/zfs/zfs_main.c:1803  destroy_clones
E034  lib/libzfs/libzfs_iter.c:565  func
E034  cmd/zfs/zfs_main.c:1917  destroy_callback
E035  cmd/zfs/zfs_main.c:1523  cb_batchedsnaps
E035  cmd/zfs/zfs_main.c:1532  destroy_batched
E035  cmd/zfs/zfs_main.c:1475  zfs_destroy_snaps_nvl
E036  cmd/zfs/zfs_main.c:1534  zfs_unmount
E036  cmd/zfs/zfs_main.c:1534  MS_FORCE
E036  lib/libzfs/libzfs_mount.c:631  libzfs_mnttab_find
E036  lib/libzfs/libzfs_mount.c:646  zfs_unshare
E036  lib/libzfs/libzfs_mount.c:650  zfs_commit_shares
E036  lib/libzfs/libzfs_mount.c:652  unmount_one
E037  lib/libzfs/os/linux/libzfs_mount_os.c:385  umount2
E037  lib/libzfs/os/linux/libzfs_mount_os.c:384  ZFS_MOUNT_HELPER
E037  module/os/linux/zfs/zpl_super.c:147  zfs_umount
E038  module/os/linux/zfs/zfs_vfsops.c:1619  zfsvfs_teardown
E038  module/os/linux/zfs/zfs_vfsops.c:1637  dmu_objset_disown
E038  module/zfs/dmu_objset.c:932  dsl_dataset_disown
E038  module/zfs/dsl_dataset.c:1052  dsl_dataset_long_rele
E039  lib/libzfs/libzfs_mount.c:589  EZFS_BUSY
E039  lib/libzfs/libzfs_mount.c:608  unmount
E039  lib/libzfs/libzfs_mount.c:654  zfs_share
E039  cmd/zfs/zfs_main.c:1543  cb_error
E040  cmd/zfs/zfs_main.c:1535  zfs_destroy
E040  lib/libzfs/libzfs_dataset.c:3834  lzc_destroy
E041  lib/libzfs_core/libzfs_core.c:379  ZFS_IOC_DESTROY
E041  module/zfs/zfs_ioctl.c:8313  zfs_ioc_destroy
E042  module/zfs/zfs_ioctl.c:4727  dsl_destroy_head
E042  module/zfs/zfs_ioctl.c:4740  recv_clone_name
E042  module/zfs/zfs_ioctl.c:4752  dsl_destroy_head
E043  module/zfs/dsl_destroy.c:1272  zfs_destroy_unmount_origin
E043  module/zfs/zfs_ioctl.c:4379  DS_IS_DEFER_DESTROY
E043  module/zfs/zfs_ioctl.c:4383  zfs_unmount_snap
E044  module/zfs/dsl_destroy.c:1287  dsl_destroy_head_begin_sync
E044  module/zfs/dsl_destroy.c:1257  DS_FLAG_INCONSISTENT
E044  module/zfs/dsl_destroy.c:1307  dmu_free_long_object
E044  module/zfs/dsl_destroy.c:1309  txg_wait_synced
E045  module/zfs/dsl_destroy.c:1315  dsl_destroy_head_sync
E045  module/zfs/dsl_destroy.c:1315  ZFS_SPACE_CHECK_DESTROY
E046  module/zfs/dsl_synctask.c:64  dst_checkfunc
E047  module/zfs/dsl_pool.c:876  dsl_sync_task_sync
E047  module/zfs/dsl_synctask.c:244  dst_checkfunc
E048  module/zfs/dsl_destroy.c:829  ds_longholds
E049  module/zfs/dsl_destroy.c:842  ds_next_snap_obj
E049  module/zfs/dsl_destroy.c:849  dd_child_dir_zapobj
E049  module/zfs/dsl_destroy.c:853  EEXIST
E049  lib/libzfs/libzfs_dataset.c:3839  destroy
E050  module/zfs/dsl_synctask.c:246  dst_syncfunc
E050  module/zfs/dsl_destroy.c:1241  dsl_destroy_head_sync_impl
E051  module/zfs/dsl_destroy.c:1143  dsl_async_dataset_destroy
E051  module/zfs/dsl_destroy.c:1052  bptree_add
E051  module/zfs/dsl_destroy.c:1059  dp_free_dir
E052  module/zfs/dsl_destroy.c:1140  dsl_async_clone_destroy
E052  module/zfs/dsl_destroy.c:997  zap_add_int
E052  module/zfs/dsl_destroy.c:1007  zthr_wakeup
E053  module/zfs/dsl_destroy.c:1145  old_synchronous_dataset_destroy
E053  module/zfs/dsl_destroy.c:807  traverse_dataset
E053  module/zfs/dsl_destroy.c:783  dsl_dataset_block_kill
E054  module/zfs/dsl_destroy.c:1242  zvol_remove_minors
E055  module/zfs/dsl_destroy.c:1081  rmorigin
E055  module/zfs/dsl_destroy.c:1225  dsl_destroy_snapshot_sync_impl
E056  module/zfs/dsl_scan.c:4001  bptree_iterate
E056  module/zfs/bptree.c:225  traverse_dataset_destroyed
E057  module/zfs/spa.c:3417  dsl_process_sub_livelist
E057  module/zfs/spa.c:3430  dsl_sync_task
E057  module/zfs/spa.c:3311  zio_free
E058  lib/libzfs/libzfs_dataset.c:3843  remove_mountpoint
E058  lib/libzfs/libzfs_mount.c:914  rmdir
E058  lib/libzfs/libzfs_mount.c:906  ZPROP_SRC_DEFAULT
E059  cmd/zpool/zpool_main.c:2382  zpool_disable_datasets
E059  lib/libzfs/libzfs_mount.c:1406  getmntent
E059  lib/libzfs/libzfs_mount.c:1467  unshare_one
E059  lib/libzfs/libzfs_mount.c:1459  qsort
E059  lib/libzfs/libzfs_mount.c:1377  mountb->mountpoint
E059  lib/libzfs/libzfs_mount.c:1479  unmount_one
E059  lib/libzfs/libzfs_mount.c:1486  remove_mountpoint
E060  cmd/zpool/zpool_main.c:2384  unmount
E061  cmd/zpool/zpool_main.c:2392  zpool_destroy
E061  lib/libzfs/libzfs_pool.c:1839  ZFS_IOC_POOL_DESTROY
E062  module/zfs/zfs_ioctl.c:8256  zfs_ioc_pool_destroy
E062  module/zfs/zfs_ioctl.c:1786  zfs_log_history
E062  module/zfs/zfs_ioctl.c:1787  spa_destroy
E063  module/zfs/spa.c:8177  POOL_STATE_DESTROYED
E064  module/zfs/spa.c:7992  spa_async_suspend
E064  module/zfs/spa.c:8024  txg_wait_synced
E064  module/zfs/spa.c:8025  spa_evicting_os_wait
E065  module/zfs/spa.c:8032  spa_refcount_zero
E065  module/zfs/zvol.c:1393  spa_open_ref
E065  module/zfs/dsl_dir.c:315  spa_open_ref
E065  module/zfs/spa.c:8033  EBUSY
E066  module/zfs/spa.c:8046  zvol_remove_minors
E066  module/zfs/spa.c:8047  taskq_wait
E067  module/zfs/spa.c:8072  vdev_initialize_stop_all
E067  module/zfs/spa.c:8085  new_state
E067  module/zfs/spa.c:8086  vdev_config_dirty
E067  module/zfs/spa.c:8108  spa_final_txg
E068  module/zfs/spa.c:8118  ESC_ZFS_POOL_DESTROY
E068  module/zfs/spa.c:8123  spa_unload
E068  module/zfs/spa.c:8124  spa_deactivate
E069  module/zfs/spa.c:2373  txg_sync_stop
E069  module/zfs/txg.c:264  txg_wait_synced
E070  module/zfs/spa.c:11529  spa_sync_rewrite_vdev_config
E070  module/zfs/spa.c:11376  spa_config_dirty_list
E070  module/zfs/spa.c:11384  vdev_config_sync
E071  module/zfs/vdev_label.c:2138  spa_config_generate
E071  module/zfs/spa_config.c:358  ZPOOL_CONFIG_POOL_STATE
E071  module/zfs/vdev_label.c:2150  vdev_label_write
E072  module/zfs/spa.c:8139  spa_write_cachefile
E072  module/zfs/spa_config.c:180  removing
E072  module/zfs/spa.c:8140  spa_remove
E073  lib/libzfs/libzfs_pool.c:1857  remove_mountpoint
E074  cmd/zpool/zpool_main.c:4410  do_destroyed
E074  cmd/zpool/zpool_main.c:4002  POOL_STATE_DESTROYED
E074  cmd/zpool/zpool_main.c:3803  POOL_STATE_EXPORTED
E075  cmd/zfs/zfs_main.c:195  zfs_do_destroy
E076  cmd/zpool/zpool_main.c:376  zpool_do_destroy
```

## Appendix D. Tunable and property source references

Where each tunable and property named in section 8 is declared, at commit `c913da8615`. A tunable's symbol is the name part as written in its `ZFS_MODULE_PARAM` line; a property's symbol is its quoted name in the `zprop_register_*()` call (`freeing` is a pool property, in `zpool_prop.c`).

```
zfs_async_block_max_blocks  module/zfs/dsl_scan.c:5539  async_block_max_blocks
zfs_free_min_time_ms  module/zfs/dsl_scan.c:5524  free_min_time_ms
zvol_inhibit_dev  module/zfs/zvol.c:2446  inhibit_dev
defer_destroy  module/zcommon/zfs_prop.c:543  "defer_destroy"
freeing  module/zcommon/zpool_prop.c:117  "freeing"
mountpoint  module/zcommon/zfs_prop.c:582  "mountpoint"
snapdev  module/zcommon/zfs_prop.c:432  "snapdev"
userrefs  module/zcommon/zfs_prop.c:660  "userrefs"
```
