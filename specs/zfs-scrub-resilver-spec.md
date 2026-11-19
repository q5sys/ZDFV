# ZFS scrub, resilver and rebuild (build spec)

This diagram answers the administrator's questions "what does a scrub or resilver actually do, why is it slow or fast, and how does a bad copy get repaired?". It follows a scan from `zpool scrub` through the ioctl into syncing context, where `dsl_scan_sync()` walks the pool's metadata once per txg, queues the data reads per top-level vdev, issues them in disk-offset order, and lets the mirror and raidz code repair any copy that fails its checksum. It shows how dirty time logs (DTLs) record what a device missed and limit a resilver to those txgs, how a second resilver is deferred, how a sequential rebuild differs, and what happens at completion.

Source of truth: `https://github.com/openzfs/zfs` at commit `c913da86156eba3243cc1ef515e98d69887654a7` (master, 2026-11-13, version 2.4.99). Every function name, file path and tunable in this document was checked against that commit.

## 0. Instructions to the building agent

1. Render with the viewer in `../viewer/` as extended by `zfs-viewer-suite-spec.md`. Page name `zfs-scrub-resilver.html`.
2. Treat sections 6 to 10 and the appendices as data. Do not add, remove, rename or re-route nodes and wires without verifying the change at the pinned commit.
3. Nodes whose role text starts with "Shared with the I/O flow graph." use the same id, title and context as in `../zfs-io-flow-diagram-spec.md`; the suite viewer cross-links them.

## 1. Goal

One page that lets a ZFS administrator see what a scrub, a resilver and a sequential rebuild do, step by step, from the command to the disk and back, and which knobs make them faster or slower.

### Mental model the diagram has to convey

1. A scrub or resilver runs inside txg sync. Once per txg, in sync pass 1, `dsl_scan_sync()` works for a time slice (at least `zfs_scrub_min_time_ms` or `zfs_resilver_min_time_ms`) and saves its position as a bookmark. While a scan is active the txg sync thread does not wait for `zfs_txg_timeout`, so txgs follow each other back to back.
2. A scan has two phases that alternate between txgs, never both in one txg: metadata traversal ("scanned" in `zpool status`), which reads indirect, dnode and objset blocks through the ARC in logical order and collects every block pointer in the txg range, and issue ("issued"), which reads the collected blocks sorted by disk offset per top-level vdev. Which phase runs depends on how much memory the queues use.
3. Scrub and resilver are the same traversal and the same read. A scrub reads every block born in its range; a resilver reads only blocks whose birth txg is in the DTL of some leaf device. Snapshots are walked oldest first and a block older than the previous snapshot is skipped, so a block shared by many snapshots is read once.
4. Repair happens in the vdev layer, not in the scan code. A scrub read on a mirror reads every child and on raidz every data and parity column; the checksum in the block pointer identifies the bad copy, and the good data is written back as a repair write. Successful repair writes are what `zpool status` reports as "repaired" or "resilvered".
5. A DTL is a per-leaf list of txgs the device is missing. It grows when a write cannot reach the device, steers which copies a read may use, decides what a resilver reads, and is rewritten from what the scan could not repair when the scan completes.
6. Scan I/O is background I/O: the scrub class in each disk's queue gets its full `zfs_vdev_scrub_max_active` only while no interactive I/O is active on that disk.
7. A sequential rebuild (`zpool attach -s`, `zpool replace -s`, dRAID spares) copies allocated space in LBA order without block pointers or checksums, then starts a scrub to verify what it copied.

### Scope

In scope: `zpool scrub` (including `-p`, `-s`, `-e`, `-t`, `-S`/`-E`, `-C`), `zpool resilver`, `zpool attach` and `zpool replace` with and without `-s`, scan setup, per-txg traversal and prefetch, sorted scan queues and issue, scrub and resilver reads with mirror and raidz repair, DTL recording and use, resilver deferral, sequential rebuild, pause, resume, cancel, error scrub, completion and replacing or spare detach.

Out of scope: async destroys (they run at the start of `dsl_scan_sync()` but are not drawn), device removal and indirect vdevs, raidz expansion, TRIM and initialize, pool checkpoints, and the fault diagnosis that decides a device is faulted (see the fault management graph).

## 2. Deliverable

Built by `../viewer/build_graph.py --spec specs/zfs-scrub-resilver-spec.md`; the page is `zfs-scrub-resilver.html` in the suite described by `zfs-viewer-suite-spec.md`.

## 6. Wire types and contexts

### 6.1 Wire types

| type id | colour | name | what travels on the wire |
|---|---|---|---|
| `abd` | `#FF6B6B` | Physical payload | abd_t: the bytes exactly as they sit on disk (compressed / encrypted / padded to ashift). |
| `arc` | `#B197FC` | ARC buffer | arc_buf_t / arc_buf_hdr_t: cached block, keyed by DVA + birth txg. |
| `zio` | `#4DABF7` | I/O request | zio_t moving through the pipeline (logical zio or a vdev child zio). |
| `bp` | `#F783AC` | Block pointer | blkptr_t: DVAs + sizes + checksum + birth txg. The address of a block. |
| `tx` | `#FFD43B` | Transaction | dmu_tx_t membership / a txg number being opened, quiesced or synced. |
| `bio` | `#E9ECEF` | Device I/O | struct bio (Linux) / GEOM bio (FreeBSD): sector I/O at the block device. |
| `ctl` | `#868E96` | Control | Calls that carry no payload: locks, wakeups, throttling, accounting, callbacks. Draw dashed. |
| `scan` | `#E599F7` | Scan work | Scan state and work items: bookmarks, the dataset queue, queued scan entries (sios) and extents, scan position and counters. |
| `dtl` | `#63E6BE` | Dirty time log | DTL range trees: the txg ranges a device is missing, and checks against them. |

### 6.2 Execution contexts

| ctx id | meaning |
|---|---|
| `user` | Userspace |
| `syscall` | Kernel, in the thread of the calling process (an ioctl on /dev/zfs, mount(2) or umount(2)) or a helper thread it starts, outside syncing context and outside any dmu_tx |
| `sync` | Syncing context: txg_sync thread or dp_sync_taskq workers, one txg at a time |
| `iss` | zio issue taskq (z_wr_iss, z_rd_iss, z_fr_iss ...): CPU work - compress, checksum, allocate |
| `int` | zio interrupt taskq (z_wr_int, z_rd_int ...): completion processing |
| `thr` | A dedicated kernel thread or zthr |
| `any` | Runs in whichever context calls it |
| `hw` | Hardware |

## 7. Groups and default layout

Flow runs left to right: commands on the left, the scan machinery in the middle, the zio pipeline, vdev tree and disks on the right.

| group id | title | colour | first column | band | sub-columns | nodes | summary |
|---|---|---|---|---|---|---|---|
| `user` | Userspace (zpool, libzfs) | `#5C5F66` | 0 | full | 1 | 5 | The commands that start, pause, stop and report a scan, and attach or replace a device. |
| `entry` | Kernel entry, spa and async work | `#2B8A3E` | 1 | full | 1 | 7 | ioctl handlers, the spa entry points and the async thread that starts resilvers and detaches replaced devices. |
| `txg` | TXG sync and scan state | `#E67700` | 2 | full | 1 | 6 | The txg sync thread, sync tasks that change the scan, and the scan state kept in the MOS. |
| `scan` | dsl_scan traversal (syncing context) | `#AE3EC9` | 3 | top | 2 | 8 | Per-txg metadata walk that finds the blocks to read. |
| `rebuild` | Sequential rebuild (vdev_rebuild) | `#5F3DC4` | 3 | bottom | 2 | 4 | Per-top-level-vdev thread that copies allocated space in LBA order. |
| `sorted` | Sorted scan queues and issue | `#9C36B5` | 5 | top | 1 | 4 | Per top-level vdev queues that turn the traversal's random order into offset order. |
| `errscrub` | Error scrub (zpool scrub -e) | `#E8590C` | 5 | bottom | 1 | 2 | Reads only the blocks listed in the pool's error log. |
| `zio` | ZIO pipeline | `#1971C2` | 6 | top | 2 | 11 | The read pipeline every scan I/O walks; shared with the I/O flow graph. |
| `dtl` | DTL - dirty time logs | `#0CA678` | 6 | bottom | 2 | 5 | What each device is missing, and how that steers resilver and repair. |
| `vdev` | VDEV tree + queues | `#C2255C` | 8 | full | 1 | 8 | Mirror and raidz read and repair logic, per-disk queues, and I/O accounting. |
| `dev` | Physical devices | `#495057` | 9 | full | 1 | 1 | The disks. |

Default layout rules:

- Column pitch is 400 px. A group starts at `first column * 400` and is `sub-columns` columns wide. A node's x is `(group first column + node sub-col) * 400`.
- Inside a sub-column, stack nodes top to bottom in the order they appear in the section 8 tables, 28 px apart. Node height follows its socket count.
- Band `full` groups start at the top. Groups `scan` (band `top`) and `rebuild` (band `bottom`) share columns 3 and 4; `sorted` (top) and `errscrub` (bottom) share column 5; `zio` (top) and `dtl` (bottom) share columns 6 and 7. Place each bottom group 90 px below the bottom of its top group.
- The layout must be deterministic. Do not run a force-directed or randomised layout in the page.
- Check the default at "fit all": group titles must be readable and no node may overlap another.

## 8. Nodes

61 nodes. `sub-col` is the node's column inside its group. `functions` are real symbols at the pinned commit (locations in Appendix A); the first one is the node's headline function.

### 8.1 Userspace (zpool, libzfs) (`user`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `admin` | Administrator | 0 | `user` | - | - | The person or script typing the command. Every path in this graph that a command starts begins with a wire from this node; the arrows that come back into a command node are its results, errors and refusals. |
| `zpool_scrub_cmd` | zpool scrub / zpool resilver | 0 | `user` | `cmd/zpool/zpool_main.c` | `zpool_do_scrub`, `zpool_do_resilver`, `scrub_callback` | `zpool scrub` options: `-p` pause, `-s` stop, `-e` error scrub, `-t` thorough (decompress and decrypt what is read), `-S`/`-E` start and end dates, `-C` continue from the last completed scrub's txg, `-w` wait. `zpool resilver` asks for a resilver to restart. Each pool is handled by scrub_callback(). |
| `zpool_attach_cmd` | zpool attach / replace | 0 | `user` | `cmd/zpool/zpool_main.c` | `zpool_do_attach_or_replace`, `zpool_do_attach`, `zpool_do_replace` | Adds a mirror side or replaces a device. Without `-s` the new device is filled by a healing resilver; with `-s` by a sequential rebuild. |
| `libzfs_scan` | libzfs / libzfs_core | 0 | `user` | `lib/libzfs/libzfs_pool.c` | `zpool_scan_range`, `zpool_vdev_attach`, `lzc_scrub` | Packs the request into an nvlist (scan_type, scan_command, scan_flags, optional dates) for ZFS_IOC_POOL_SCRUB, or a zfs_cmd_t for ZFS_IOC_VDEV_ATTACH. |
| `zpool_status` | zpool status (scan line) | 0 | `user` | `cmd/zpool/zpool_main.c` | `print_scan_scrub_resilver_status`, `print_rebuild_status` | Reports "scanned" (bytes examined by the traversal), "issued" (bytes whose read was sent) and "repaired" or "resilvered" (bytes written by repair writes). Percent done and the time estimate come from issued bytes and the issue rate, so a scan that is still traversing shows no estimate. Rebuilds are reported per top-level vdev. |

### 8.2 Kernel entry, spa and async work (`entry`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `ioc_scrub` | zfs_ioc_pool_scrub() | 0 | `syscall` | `module/zfs/zfs_ioctl.c` | `zfs_ioc_pool_scrub` | Validates the request and routes it: pause, stop, or start with a txg range. Dates are turned into txgs through the pool's txg time log, `-C` starts at the txg the last completed scrub ended at. |
| `spa_scan` | spa_scan_range() / spa_scan_stop() / spa_scrub_pause_resume() | 0 | `syscall` | `module/zfs/spa.c` | `spa_scan_range`, `spa_scan`, `spa_scan_stop`, `spa_scrub_pause_resume` | Checks before the dsl layer: a txg range only for a scrub; a requested resilver needs the resilver_defer feature enabled and does nothing but request SPA_ASYNC_RESILVER_DONE when no leaf has a DTL; an error scrub needs the head_errlog feature; pause and stop return EBUSY while a resilver runs. |
| `dsl_scan_entry` | dsl_scan() / dsl_scan_cancel() | 0 | `any` | `module/zfs/dsl_scan.c` | `dsl_scan`, `dsl_scan_cancel`, `dsl_scrub_set_pause_resume`, `dsl_scan_restart_resilver` | Open-context side of the scan. dsl_scan() first reopens and probes every vdev, then: a resilver only sets scn_restart_txg (dsl_scan_restart_resilver()), a paused scrub or error scrub is resumed, anything else queues a setup sync task. Cancel and pause also go through sync tasks. dsl_scan_restart_resilver() is also called by the async thread and by attach. |
| `ioc_attach` | spa_vdev_attach() | 0 | `syscall` | `module/zfs/spa.c` | `zfs_ioc_vdev_attach`, `spa_vdev_attach` | Adds the new device under a mirror, replacing or spare vdev, marks it as missing every txg so far, and starts a resilver (or defers it) or, with `-s`, a rebuild. |
| `spa_async` | spa_async_thread() | 0 | `thr` | `module/zfs/spa.c` | `spa_async_thread`, `spa_async_request` | Background worker for requests that need locks sync context cannot take: SPA_ASYNC_RESILVER restarts a resilver, SPA_ASYNC_RESILVER_DONE and SPA_ASYNC_REBUILD_DONE detach finished replacements. |
| `vdev_open_assess` | vdev_open() resilver check | 0 | `any` | `module/zfs/vdev.c` | `vdev_open`, `dsl_scan_assess_vdev` | Every time a leaf is opened (import, online, clear, reopen) its DTL is checked. Missing txgs start a resilver, or are deferred, unless the open is the probe a starting scrub does (spa_scrub_reopen). |
| `resilver_done` | spa_vdev_resilver_done() | 0 | `thr` | `module/zfs/spa.c` | `spa_vdev_resilver_done`, `spa_vdev_resilver_done_hunt`, `spa_vdev_detach` | Finds replacing and spare vdevs whose new device is complete and detaches the old device (and the hot spare it replaced), which ends a `zpool replace`. |

### 8.3 TXG sync and scan state (`txg`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `txg_sync` | TXG: syncing (txg_sync_thread) | 0 | `thr` | `module/zfs/txg.c` | `txg_sync_thread`, `txg_wait_synced` | Shared with the I/O flow graph. Normally waits up to zfs_txg_timeout between txgs; while dsl_scan_active() is true (a scan running and not paused, or frees pending) it syncs the next txg at once, so the scan gets a slice of every txg. Sync tasks that set up, pause or cancel a scan wait here for their txg. Tunables: `zfs_txg_timeout`. |
| `spa_sync` | spa_sync() | 0 | `sync` | `module/zfs/spa.c` | `spa_sync`, `spa_sync_iterate_to_convergence` | Shared with the I/O flow graph. Each sync pass runs dsl_pool_sync() (which executes queued sync tasks), then dsl_scan_sync() and dsl_errorscrub_sync(), then vdev_sync() for dirty top-level vdevs, which writes changed DTLs. |
| `scan_setup` | dsl_scan_setup_sync() | 0 | `sync` | `module/zfs/dsl_scan.c` | `dsl_scan_setup_check`, `dsl_scan_setup_sync`, `dsl_errorscrub_setup_check`, `dsl_errorscrub_setup_sync` | Starts a scan in syncing context. Refused (EBUSY) while a scan, rebuild or error scrub runs. Resets scn_phys, records the txg range (a resilver's range comes from the DTLs), rewrites all labels, creates the dataset queue object and posts a scrub or resilver start event. The error scrub variant points a cursor at the last error log instead. |
| `scan_ctl_sync` | Pause / resume / cancel tasks | 0 | `sync` | `module/zfs/dsl_scan.c` | `dsl_scrub_pause_resume_check`, `dsl_scrub_pause_resume_sync`, `dsl_scan_cancel_check`, `dsl_scan_cancel_sync` | Sync tasks for `zpool scrub -p`, a resume, and `zpool scrub -s`. Pause only sets DSF_SCRUB_PAUSED: the queues and bookmark stay, and the scan continues where it was when resumed. |
| `scan_state` | Scan state in the MOS (scn_phys) | 0 | `sync` | `module/zfs/dsl_scan.c` | `dsl_scan_sync_state`, `dsl_errorscrub_sync_state`, `dsl_scan_init`, `spa_scan_get_stats` | dsl_scan_phys_t in the pool directory: function, state, txg range, bookmark, DDT bookmark, counters (to_examine, examined, skipped, processed, errors). It is written only when the sorted queues are empty, so after an import a scan restarts from its last checkpoint. dsl_scan_init() reloads it at import. |
| `scan_done` | dsl_scan_done() | 0 | `sync` | `module/zfs/dsl_scan.c` | `dsl_scan_done` | Ends a scan, completed or cancelled: frees the dataset queue and sorted queues, reassesses DTLs, sets the final state, rotates the error log, asks the async thread to detach finished replacements and to start a deferred resilver if one is due. |

### 8.4 dsl_scan traversal (syncing context) (`scan`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `scan_sync` | dsl_scan_sync() | 0 | `sync` | `module/zfs/dsl_scan.c` | `dsl_scan_sync`, `dsl_scan_active`, `dsl_scan_should_clear` | The per-txg driver, sync pass 1 only. Restarts the scan when scn_restart_txg is reached, waits zfs_import_defer_txgs after an import, runs async destroys first, does nothing while paused. Then, for a sorted scan, decides from queue memory and the checkpoint timer whether this txg traverses metadata or issues queued reads; never both. When traversal is complete and the queues are empty, it ends the scan. Tunables: `zfs_scan_legacy`, `zfs_scan_checkpoint_intval`, `zfs_scan_mem_lim_fact`, `zfs_scan_mem_lim_soft_fact`, `zfs_import_defer_txgs`. |
| `scan_suspend` | Per-txg time limit | 0 | `sync` | `module/zfs/dsl_scan.c` | `dsl_scan_check_suspend`, `scan_io_queue_check_suspend` | After the minimum time (750 ms scrub, 1500 ms resilver by default) the scan yields when dirty data reaches zfs_vdev_async_write_active_min_dirty_percent of zfs_dirty_data_max, when someone waits for the txg, or when zfs_txg_timeout has passed since the txg started; always when the pool is exporting. So application writes and `sync` shorten each scan slice. Tunables: `zfs_scrub_min_time_ms`, `zfs_resilver_min_time_ms`, `zfs_txg_timeout`, `zfs_dirty_data_max`, `zfs_vdev_async_write_active_min_dirty_percent`, `zfs_scan_strict_mem_lim`. |
| `scan_visit` | dsl_scan_visit() / dataset queue | 0 | `sync` | `module/zfs/dsl_scan.c` | `dsl_scan_visit`, `dsl_scan_visitds`, `dsl_scan_visit_rootbp`, `scan_ds_queue_insert` | Order of the walk: the DDT pass, then the MOS, then $ORIGIN, then datasets from the in-memory queue. After a dataset is finished its next snapshot and its clones are queued with the creation txg as their lower bound, so each later snapshot is only searched for blocks born after the previous one. Also scans the head dataset's ZIL blocks. |
| `scan_ddt` | DDT pass (dsl_scan_ddt) | 0 | `sync` | `module/zfs/dsl_scan.c` | `dsl_scan_ddt`, `dsl_scan_ddt_entry` | Before the tree walk, a scrub or resilver reads every dedup table entry with more than one reference once (when the scan has a start txg, only the obsolete ditto class), so the tree walk can skip those blocks however many files point to them. |
| `scan_visitbp` | dsl_scan_visitbp() recursion | 1 | `sync` | `module/zfs/dsl_scan.c` | `dsl_scan_visitbp`, `dsl_scan_recurse`, `dsl_scan_visitdnode`, `dsl_scan_check_resume` | Depth-first walk of one block tree. Skips holes and every block not born after cur_min_txg (its whole subtree is older), reads indirect, dnode and objset blocks synchronously to find their children, and hands each block, metadata included, to the scan callback. On resume, subtrees before the bookmark are skipped. |
| `scan_prefetch` | Scan prefetch thread | 1 | `sync` | `module/zfs/dsl_scan.c` | `dsl_scan_prefetch_thread`, `dsl_scan_prefetch`, `dsl_scan_prefetch_dnode`, `dsl_scan_prefetch_cb` | Runs on dp_sync_taskq beside the traversal. Reads indirect, dnode and objset blocks ahead of it into the ARC (never level-0 data), so the traversal's synchronous reads are cache hits. Shares scn_maxinflight_bytes (zfs_scan_vdev_limit x data disks, at most a quarter of the ARC maximum). Tunables: `zfs_no_scrub_prefetch`. |
| `scrub_cb` | dsl_scan_scrub_cb() | 1 | `sync` | `module/zfs/dsl_scan.c` | `dsl_scan_scrub_cb`, `count_block_skipped` | Decides whether a block is read. Blocks born outside (scn_min_txg, scn_max_txg) are only counted. A scrub reads every other block; a resilver only those that dsl_scan_need_resilver() selects. Sets the zio flags: SCRUB or RESILVER, SCAN_THREAD, CANFAIL, and RAW unless the scrub is thorough. Tunables: `zfs_no_scrub_io`. |
| `need_resilver` | dsl_scan_need_resilver() | 1 | `sync` | `module/zfs/dsl_scan.c` | `dsl_scan_need_resilver`, `dsl_scan_check_deferred` | Per DVA: does the top-level vdev holding it have a DTL that covers the block's physical birth txg (for raidz: on a child holding part of the block), and is at least one leaf under it not deferred? Blocks on vdevs with no missing data are skipped, which is why a resilver of a mostly-current device is short. |

### 8.5 Sequential rebuild (vdev_rebuild) (`rebuild`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `rebuild_start` | vdev_rebuild() | 0 | `any` | `module/zfs/vdev_rebuild.c` | `vdev_rebuild`, `vdev_rebuild_initiate`, `vdev_rebuild_initiate_sync` | Starts a rebuild of one top-level vdev (mirror or dRAID): a sync task activates the device_rebuild feature, records the DTL txg range and creates the rebuild thread. If one is already running it is reset to include the new device. |
| `rebuild_thread` | vdev_rebuild_thread() | 0 | `thr` | `module/zfs/vdev_rebuild.c` | `vdev_rebuild_thread`, `vdev_rebuild_ranges` | Walks the top-level vdev's metaslabs in order. Each metaslab is disabled for allocation, its allocated ranges are loaded from the space map, and they are rebuilt in LBA order. Block pointers and checksums are never looked at, and data held only by a checkpoint is rebuilt too. Progress is kept per top-level vdev, so rebuilds of different vdevs are independent. Tunables: `zfs_rebuild_vdev_limit`, `zfs_rebuild_max_segment`. |
| `rebuild_range` | vdev_rebuild_range() | 1 | `thr` | `module/zfs/vdev_rebuild.c` | `vdev_rebuild_range`, `vdev_rebuild_blkptr_init`, `vdev_rebuild_cb` | Issues one rebuild read for a chunk of allocated space, described by a made-up block pointer with checksum off, and records the progress offset per txg. |
| `rebuild_done` | vdev_rebuild_complete_sync() | 1 | `sync` | `module/zfs/vdev_rebuild.c` | `vdev_rebuild_complete_sync` | Marks the rebuild complete, excises the DTLs, requests the detach of the replaced device and, when no other scan runs, starts a scrub to verify checksums. Tunables: `zfs_rebuild_scrub_enabled`. |

### 8.6 Sorted scan queues and issue (`sorted`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `scan_enqueue` | dsl_scan_enqueue() | 0 | `sync` | `module/zfs/dsl_scan.c` | `dsl_scan_enqueue`, `scan_io_queue_insert`, `scan_io_queue_insert_impl` | Sorted scan: one queue entry per DVA, in the queue of the top-level vdev that DVA is on, carrying all DVAs so a repair can use the other copies. Legacy scans and gang blocks are read at once instead. |
| `scan_queue` | Scan queue per top-level vdev | 0 | `sync` | `module/zfs/dsl_scan.c` | `scan_io_queue_create`, `ext_size_compare`, `dsl_scan_freed`, `dsl_scan_freed_dva` | Entries (sios) sorted by offset, plus extents: offset ranges merged across gaps up to zfs_scan_max_ext_gap and scored by size and fill. Its memory is what decides between traversing and issuing. A block freed while queued is removed. Tunables: `zfs_scan_max_ext_gap`, `zfs_scan_fill_weight`. |
| `queues_run` | scan_io_queues_run() | 0 | `sync` | `module/zfs/dsl_scan.c` | `scan_io_queues_run`, `scan_io_queues_run_one`, `scan_io_queue_fetch_ext`, `scan_io_queue_gather`, `scan_io_queue_issue` | One thread per top-level vdev on the dsl_scan_iss taskq, while dsl_scan_sync() waits. Each picks extents and issues their entries in offset order until the time limit. Strategy (zfs_scan_issue_strategy): 0 = best extents first while clearing memory, LBA order while checkpointing; 1 = always LBA order; 2 = always best first. Tunables: `zfs_scan_issue_strategy`. |
| `scan_exec_io` | scan_exec_io() | 0 | `sync` | `module/zfs/dsl_scan.c` | `scan_exec_io`, `dsl_scan_scrub_done`, `count_block_issued` | Creates the scan read. Waits while the queue's bytes in flight are at zfs_scan_vdev_limit x data disks of that top-level vdev (pool-wide limit for legacy and error scrub reads). Counts issued bytes. The read goes straight to zio_read() with its own buffer: scan data never enters the ARC. Tunables: `zfs_scan_vdev_limit`. |

### 8.7 Error scrub (zpool scrub -e) (`errscrub`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `errscrub_sync` | dsl_errorscrub_sync() | 0 | `sync` | `module/zfs/dsl_scan.c` | `dsl_errorscrub_sync`, `scrub_filesystem`, `dsl_error_scrub_check_suspend`, `dsl_errorscrub_done` | Walks the last error log instead of the pool. With head_errlog it reads the block in the head dataset when it is unchanged and in the snapshots that still hold that version. Runs in sync pass 1 after dsl_scan_sync(); a resilver cancels it. When the log is done, the error log is rotated: the errors found by this pass replace the previous log, so blocks that now read cleanly drop out of `zpool status -v`. Tunables: `zfs_scrub_error_blocks_per_txg`. |
| `errscrub_read` | read_by_block_level() | 0 | `sync` | `module/zfs/dsl_scan.c` | `read_by_block_level` | Looks up the block's current block pointer through the dnode (needs the dataset's key if encrypted) and issues it as a scrub read. |

### 8.8 ZIO pipeline (`zio`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `arc_read` | arc_read() | 0 | `any` | `module/zfs/arc.c` | `arc_read` | Shared with the I/O flow graph. Used by the traversal and the prefetch thread for metadata only, at ZIO_PRIORITY_SCRUB. Data blocks read by the scan do not pass through the ARC. |
| `zio_create` | zio create + execute | 0 | `any` | `module/zfs/zio.c` | `zio_read`, `zio_root`, `zio_nowait`, `zio_wait` | Shared with the I/O flow graph. Scan reads are ordinary zio_read() calls with scan flags; each txg's scan reads hang under a root zio that dsl_scan_sync() waits for. |
| `st_read_bp_init` | READ_BP_INIT | 0 | `any` | `module/zfs/zio.c` | `zio_read_bp_init` | Shared with the I/O flow graph. Queues decompress and decrypt for the completion, except for RAW reads: a normal scrub only verifies the stored bytes, a thorough scrub also decompresses and decrypts them. |
| `st_ready` | READY | 0 | `any` | `module/zfs/zio.c` | `zio_ready` | Shared with the I/O flow graph. A read passes straight through. |
| `st_vdev_io_start` | VDEV_IO_START | 0 | `any` | `module/zfs/zio.c` | `zio_vdev_io_start`, `zio_vdev_io_bypass` | Shared with the I/O flow graph. Routes the zio down the vdev tree. A repair write without SELF_HEAL is skipped on a vdev whose DTL says it is not missing that txg. A leaf that is not accessible fails the zio with ENXIO without touching the disk. |
| `st_free` | FREE stages | 0 | `sync` | `module/zfs/zio.c` | `zio_dva_free`, `zio_free_sync` | Shared with the I/O flow graph. Before space is returned to its metaslab, the scan is told so it can drop a queued read of that block. |
| `zio_taskq` | zio taskqs (issue / interrupt) | 1 | `iss` | `module/zfs/spa.c` | `zio_taskq_dispatch`, `zio_interrupt` | Shared with the I/O flow graph. Completions continue on an interrupt taskq. |
| `st_vdev_io_done` | VDEV_IO_DONE | 1 | `int` | `module/zfs/zio.c` | `zio_vdev_io_done` | Shared with the I/O flow graph. Releases the queue slot and lets the mirror or raidz code inspect its children: this is where bad copies are found and repair writes are created. |
| `st_vdev_io_assess` | VDEV_IO_ASSESS | 1 | `int` | `module/zfs/zio.c` | `zio_vdev_io_assess` | Shared with the I/O flow graph. A failed leaf zio is turned into ENXIO when the device is no longer accessible; child zios are not retried. |
| `st_cksum_verify` | CHECKSUM_VERIFY | 1 | `int` | `module/zfs/zio.c` | `zio_checksum_verify`, `zio_checksum_error` | Shared with the I/O flow graph. Runs in each child that carries the block pointer (mirror sides, plain disks). A mismatch increments the device's checksum error count and starts a checksum ereport. Raidz checks the checksum itself in vdev_raidz_io_done(). |
| `st_done` | DONE | 1 | `int` | `module/zfs/zio.c` | `zio_done` | Shared with the I/O flow graph. Updates per-vdev statistics, runs the done callback (scan, rebuild) and notifies the parent. |

### 8.9 DTL - dirty time logs (`dtl`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `dtl_dirty` | vdev_dtl_dirty() | 0 | `any` | `module/zfs/vdev.c` | `vdev_dtl_dirty` | Adds a txg range to one of a vdev's four DTLs. DTL_MISSING: txgs the vdev has no valid copy of. DTL_PARTIAL: txgs not fully replicated below it. DTL_SCRUB: txgs a running scan could not repair. DTL_OUTAGE: txgs that cannot be read right now. Only the leaves' DTL_MISSING is stored on disk. |
| `dtl_query` | DTL range checks | 0 | `any` | `module/zfs/vdev.c` | `vdev_dtl_contains`, `vdev_dtl_empty`, `vdev_resilver_needed`, `vdev_dtl_need_resilver`, `vdev_default_need_resilver`, `vdev_raidz_need_resilver`, `vdev_dtl_required` | The questions asked of DTLs: does this vdev miss txg N, does any writable leaf need resilver and for which range, does this block's DVA touch a dirty child, and can this device be detached without losing data. |
| `resilver_defer` | Resilver deferral | 0 | `any` | `module/zfs/vdev.c` | `vdev_defer_resilver`, `vdev_clear_resilver_deferred` | With the resilver_defer feature enabled, a device that needs resilver while one is running is flagged instead of restarting the running resilver from the beginning. Its DTL is not cleared by the running resilver; a second resilver starts for it when the first ends. Tunables: `zfs_resilver_disable_defer`, `zfs_resilver_defer_percent`. |
| `dtl_reassess` | vdev_dtl_reassess() | 1 | `any` | `module/zfs/vdev.c` | `vdev_dtl_reassess`, `vdev_dtl_reassess_impl`, `vdev_dtl_should_excise` | Recomputes DTLs bottom up. After a completed scan that had no errors or was started since the pool was imported (a rebuild: that had no errors), a leaf that is at least degraded, not deferred and, if it was attached for this resilver, whose DTL ends inside the scanned range gets DTL_MISSING below the scan's max txg replaced by DTL_SCRUB, the txgs the scan could not repair. Interior vdevs derive theirs from the children: a mirror misses a txg only when every child does, raidz when more than nparity children do. Tunables: `zfs_scan_ignore_errors`. |
| `dtl_sync` | vdev_dtl_sync() | 1 | `sync` | `module/zfs/vdev.c` | `vdev_dtl_sync`, `vdev_dirty`, `vdev_sync` | Writes a leaf's DTL_MISSING to its own space map object in the MOS when it changed in this txg, so missing txgs survive a reboot. Tunables: `zfs_vdev_dtl_sm_blksz`. |

### 8.10 VDEV tree + queues (`vdev`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `vdev_dva_fanout` | DVA fan-out (copies / ditto) | 0 | `any` | `module/zfs/vdev_mirror.c` | `vdev_mirror_io_start`, `vdev_mirror_map_init` | Shared with the I/O flow graph. For a scan read the logical zio's DVAs are treated as mirror sides. A sorted scrub checks only the first DVA, because each DVA has its own queued entry; the other copies are kept for repair. |
| `vdev_mirror` | Mirror vdev | 0 | `any` | `module/zfs/vdev_mirror.c` | `vdev_mirror_io_start_impl`, `vdev_mirror_child_select`, `vdev_mirror_io_done` | Shared with the I/O flow graph. Scrub: reads every readable child and keeps a buffer for each. Resilver and rebuild: read one child that is not missing the data. On completion it rewrites children that returned errors and, for a resilver, children whose DTL has the txg. Replacing and spare vdevs are mirrors too. |
| `vdev_raidz` | RAIDZ / dRAID vdev | 0 | `any` | `module/zfs/vdev_raidz.c` | `vdev_raidz_io_start`, `vdev_raidz_io_start_read_row`, `vdev_raidz_io_done`, `raidz_checksum_verify`, `vdev_raidz_combrec`, `raidz_parity_verify`, `vdev_raidz_io_done_verified`, `vdev_draid_io_start`, `vdev_draid_io_start_read` | Shared with the I/O flow graph. Scrub and resilver read all data and parity columns. The whole block is checked against its checksum here; if it fails, every column is read and combinations of columns are rebuilt from parity until the checksum matches. Unused parity is verified too, and wrong or missing columns are rewritten. |
| `vdev_child_io` | zio_vdev_child_io() | 0 | `any` | `module/zfs/zio.c` | `zio_vdev_child_io` | Shared with the I/O flow graph. Creates the read or repair-write child for one vdev below; a child with a block pointer checks the checksum itself. |
| `vdev_queue` | Per-disk I/O queue | 0 | `any` | `module/zfs/vdev_queue.c` | `vdev_queue_io`, `vdev_queue_io_to_issue`, `vdev_queue_class_max_active`, `vdev_queue_io_done` | Shared with the I/O flow graph. Scan reads use the scrub class, rebuild reads the rebuild class, repair writes the async write class. Scrub and rebuild are non-interactive: while sync or async I/O is active on the disk they get their min_active, and at most zfs_vdev_nia_credit of them are sent while interactive I/O is outstanding; only after zfs_vdev_nia_delay of them complete on an otherwise idle disk do they get max_active. Tunables: `zfs_vdev_scrub_min_active`, `zfs_vdev_scrub_max_active`, `zfs_vdev_rebuild_min_active`, `zfs_vdev_rebuild_max_active`, `zfs_vdev_nia_delay`, `zfs_vdev_nia_credit`, `zfs_vdev_max_active`. |
| `vdev_leaf` | Leaf vdev driver | 0 | `any` | `module/os/linux/zfs/vdev_disk.c` | `vdev_disk_io_start`, `vdev_geom_io_start` | Shared with the I/O flow graph. Turns the zio into a block-device request. |
| `vdev_intr` | I/O completion | 0 | `int` | `module/os/linux/zfs/vdev_disk.c` | `vbio_completion`, `vdev_geom_io_intr`, `zio_interrupt` | Shared with the I/O flow graph. Records the result and re-enters the pipeline on an interrupt taskq. |
| `vdev_stats` | vdev_stat_update() | 0 | `any` | `module/zfs/vdev.c` | `vdev_stat_update`, `vdev_scan_stat_init` | Per-vdev accounting at the end of every zio. Successful repair writes are counted as scan progress (scn_processed) or rebuild progress (vrp_bytes_rebuilt). Failed writes are recorded in the DTLs. |

### 8.11 Physical devices (`dev`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `dev_normal` | Data disks (normal class) | 0 | `hw` | - | - | Shared with the I/O flow graph. The pool's disks; scan reads and repair writes land here (and on special and dedup vdevs, which are not drawn separately). |

## 9. Wires

124 wires. A wire runs from the node that hands something over to the node that receives it. Returns from function calls are mostly not drawn. `on paths` lists the section 10 paths that use the wire.

| wire | from | to | type | label | on paths |
|---|---|---|---|---|---|
| E001 | `zpool_scrub_cmd` | `libzfs_scan` | `ctl` | zpool_do_scrub() / zpool_do_resilver(): options become scan type, command and flags; scrub_callback() -> zpool_scan_range() for each pool | scrub_start, pause_cancel, error_scrub |
| E002 | `libzfs_scan` | `ioc_scrub` | `ctl` | lzc_scrub(ZFS_IOC_POOL_SCRUB, pool, {scan_type, scan_command, scan_flags, dates}) | scrub_start, pause_cancel, error_scrub |
| E003 | `ioc_scrub` | `spa_scan` | `ctl` | -p: spa_scrub_pause_resume(); scan type none (-s): spa_scan_stop(); otherwise -C (spa_get_last_scrubbed_txg()) or -S/-E (dbrrd_query()) give a txg range and spa_scan_range() | scrub_start, pause_cancel, error_scrub |
| E004 | `spa_scan` | `dsl_scan_entry` | `ctl` | dsl_scan() to start or resume, dsl_scrub_set_pause_resume() to pause, dsl_scan_cancel() to stop | scrub_start, pause_cancel, error_scrub |
| E005 | `dsl_scan_entry` | `vdev_open_assess` | `ctl` | vdev_reopen() of the whole tree with spa_scrub_reopen set: every device is probed, and no resilver is requested from these opens | scrub_start |
| E006 | `dsl_scan_entry` | `txg_sync` | `tx` | dsl_sync_task(check, sync): the task rides on a tx in the open txg and the caller waits in txg_wait_synced() | scrub_start, pause_cancel, error_scrub |
| E007 | `txg_sync` | `spa_sync` | `ctl` | txg_sync_thread(): spa_sync(txg); no idle wait for zfs_txg_timeout while dsl_scan_active() | scrub_start, scan_txg, sorted_issue, pause_cancel, error_scrub |
| E008 | `spa_sync` | `scan_setup` | `ctl` | dsl_pool_sync() runs the queued task: dsl_scan_setup_check() (EBUSY if a scan, rebuild or error scrub runs) then dsl_scan_setup_sync(), or dsl_errorscrub_setup_sync() for -e | scrub_start, error_scrub |
| E009 | `scan_setup` | `dtl_query` | `dtl` | vdev_resilver_needed(root): if a writable leaf has DTL_MISSING, scn_min_txg and scn_max_txg become the range of all such DTLs and a resilver start event is posted, otherwise a scrub start event | scrub_start, resilver |
| E010 | `scan_setup` | `scan_state` | `scan` | scn_phys reset: function, flags, DSS_SCANNING, txg range, to_examine = allocated bytes; dataset queue object created; dsl_scan_sync_state(SYNC_MANDATORY) | scrub_start, resilver, rebuild |
| E011 | `spa_sync` | `scan_sync` | `ctl` | spa_sync_iterate_to_convergence(): dsl_scan_sync(dp, tx), which only works in sync pass 1 | scan_txg, sorted_issue, resilver, pause_cancel, scan_complete |
| E012 | `scan_sync` | `scan_visit` | `scan` | not clearing and traversal not finished: zio_root() for this txg's reads, then dsl_scan_visit() under dsl_pool_config_enter() | scan_txg, resilver |
| E013 | `scan_sync` | `scan_prefetch` | `scan` | taskq_dispatch(dp_sync_taskq, dsl_scan_prefetch_thread); stopped (scn_prefetch_stop) before dsl_scan_sync() returns | scan_txg |
| E014 | `scan_visit` | `scan_ddt` | `scan` | while the DDT bookmark is within scn_ddt_class_max: dsl_scan_ddt() first | scan_txg |
| E015 | `scan_ddt` | `scrub_cb` | `bp` | dsl_scan_ddt_entry(): ddt_bp_create() for each copy born up to scn_max_txg, then scan_funcs[func]() | scan_txg |
| E016 | `scan_visit` | `scan_visitbp` | `bp` | dsl_scan_visit_rootbp(): the MOS, then each dataset from scn_queue with cur_min_txg = the txg it was queued with (the previous snapshot's creation txg), at least scn_min_txg | scan_txg, resilver |
| E017 | `scan_visit` | `scan_prefetch` | `scan` | dsl_scan_visit_rootbp(): dsl_scan_prefetch() of the objset root starts this dataset's prefetch | scan_txg |
| E018 | `scan_visitbp` | `scan_suspend` | `ctl` | dsl_scan_check_suspend() at each level-0 or objset block: minimum time used, and dirty data, a waiter or zfs_txg_timeout says stop | scan_txg |
| E019 | `scan_suspend` | `scan_visitbp` | `scan` | suspend: the block's bookmark is saved in scn_bookmark; next txg dsl_scan_check_resume() skips every subtree completed before it | scan_txg |
| E020 | `scan_visitbp` | `arc_read` | `bp` | dsl_scan_recurse(): indirect, dnode and objset blocks read with arc_read(ARC_FLAG_WAIT, ZIO_PRIORITY_SCRUB, SCAN_THREAD) | scan_txg, resilver |
| E021 | `arc_read` | `scan_visitbp` | `arc` | buffer of child block pointers: dsl_scan_visitbp() on each (dsl_scan_visitdnode() for each dnode of a dnode block) | scan_txg, resilver |
| E022 | `scan_prefetch` | `arc_read` | `bp` | dsl_scan_prefetch_thread(): arc_read(scn_zio_root, ZIO_PRIORITY_SCRUB, NOWAIT + PREFETCH + PRESCIENT_PREFETCH) while spa_scrub_inflight is below scn_maxinflight_bytes | scan_txg |
| E023 | `arc_read` | `scan_prefetch` | `arc` | done callback dsl_scan_prefetch_cb(): the block's children are queued for prefetch, except level-0 data | scan_txg |
| E024 | `scan_visitbp` | `scrub_cb` | `bp` | block born after cur_min_txg, not covered by the DDT pass, not newer than cur_max_txg: scan_funcs[func]() = dsl_scan_scrub_cb() | scan_txg, resilver |
| E025 | `scrub_cb` | `need_resilver` | `bp` | resilver: dsl_scan_need_resilver(spa, dva, psize, physical birth) for each DVA | resilver, resilver_defer |
| E026 | `need_resilver` | `dtl_query` | `dtl` | vdev_dtl_need_resilver(top-level vdev): mirror: its DTL_PARTIAL has the birth txg; raidz: that, and a child holding one of the block's columns has it; a single-disk top-level vdev: always | resilver |
| E027 | `need_resilver` | `resilver_defer` | `ctl` | dsl_scan_check_deferred(): the block is skipped only if every leaf under this top-level vdev is deferred | resilver, resilver_defer |
| E028 | `need_resilver` | `scrub_cb` | `bp` | B_TRUE for any DVA: the block is read; otherwise it is counted as skipped | resilver |
| E029 | `scrub_cb` | `scan_enqueue` | `bp` | dsl_scan_enqueue(bp, ZIO_FLAG_SCRUB or ZIO_FLAG_RESILVER, SCAN_THREAD, CANFAIL, RAW unless thorough) | scan_txg, resilver |
| E030 | `scan_enqueue` | `scan_queue` | `scan` | sorted: per DVA, scan_io_queue_insert() into its top-level vdev's queue: the sio into q_sios_by_addr, its range into q_exts_by_addr | scan_txg, resilver |
| E031 | `scan_enqueue` | `scan_exec_io` | `bp` | legacy scan (zfs_scan_legacy) or a gang block: scan_exec_io() at once, in traversal order | scan_txg |
| E032 | `scan_sync` | `scan_state` | `scan` | end of dsl_scan_sync(): dsl_scan_sync_state(); scn_phys is written only when the sorted queues are empty, otherwise the last consistent copy stays | scan_txg, sorted_issue |
| E033 | `scan_sync` | `scan_queue` | `ctl` | dsl_scan_should_clear(): queue memory at the hard limit (physmem / zfs_scan_mem_lim_fact, at most 1/20 of allocated space) starts clearing, below the soft limit it stops; after zfs_scan_checkpoint_intval or when traversal ends, checkpoint: clear everything | sorted_issue |
| E034 | `scan_sync` | `queues_run` | `scan` | clearing and sios pending: scan_io_queues_run() instead of dsl_scan_visit() | sorted_issue, resilver, scan_complete |
| E035 | `scan_queue` | `queues_run` | `scan` | per top-level vdev: scan_io_queue_fetch_ext() picks an extent (zfs_scan_issue_strategy), scan_io_queue_gather() takes up to 32 of its sios in offset order | sorted_issue, resilver |
| E036 | `queues_run` | `scan_suspend` | `ctl` | scan_io_queue_check_suspend() before each sio: same time and dirty-data rules as the traversal | sorted_issue |
| E037 | `queues_run` | `scan_queue` | `scan` | stopped inside an extent: unissued sios go back with scan_io_queue_insert_impl() | sorted_issue |
| E038 | `queues_run` | `scan_exec_io` | `bp` | sio2bp() rebuilds the block pointer; scan_exec_io(queue) | sorted_issue, resilver |
| E039 | `scan_exec_io` | `zio_create` | `zio` | waits while bytes in flight reach the limit, then zio_read(bp, new buffer, dsl_scan_scrub_done, ZIO_PRIORITY_SCRUB, flags): no ARC | scan_txg, sorted_issue, scrub_repair, resilver, error_scrub |
| E040 | `st_done` | `scan_exec_io` | `ctl` | done callback dsl_scan_scrub_done(): in-flight bytes released; an error redundancy could not fix counts in scn_errors (dep_errors in an error scrub) | sorted_issue, scrub_repair, error_scrub |
| E041 | `st_free` | `scan_queue` | `scan` | zio_dva_free() or zio_free_sync(): dsl_scan_freed() removes a queued sio of the freed block, so the space can be reused safely | sorted_issue |
| E042 | `scan_state` | `zpool_status` | `scan` | spa_scan_get_stats() into the config (ZPOOL_CONFIG_SCAN_STATS): examined = scanned, issued, processed = repaired / resilvered; time estimate from the issue rate | scrub_start, sorted_issue, pause_cancel, error_scrub, scan_complete |
| E043 | `zio_create` | `st_read_bp_init` | `zio` | ZIO_READ_PIPELINE; RAW scrub reads push no decompress or decrypt transform | scrub_repair, resilver, rebuild |
| E044 | `st_read_bp_init` | `st_ready` | `zio` | nothing to allocate: on to READY | scrub_repair, resilver, rebuild |
| E045 | `st_ready` | `st_vdev_io_start` | `zio` | logical zio enters VDEV_IO_START | scrub_repair, resilver, dtl_record, rebuild |
| E046 | `st_vdev_io_start` | `vdev_dva_fanout` | `zio` | logical zio: vdev_mirror_map_init() over the DVAs; a sorted scrub uses only the first DVA unless retrying | scrub_repair, resilver, dtl_record, rebuild |
| E047 | `vdev_dva_fanout` | `vdev_child_io` | `zio` | child zio for the chosen DVA's top-level vdev, carrying the bp | scrub_repair, resilver, dtl_record, rebuild |
| E048 | `vdev_child_io` | `st_vdev_io_start` | `zio` | child zio (ZIO_VDEV_CHILD_PIPELINE) enters VDEV_IO_START on its vdev; with a bp the checksum check moves into the child | scrub_repair, resilver, dtl_record, rebuild |
| E049 | `st_vdev_io_start` | `vdev_mirror` | `zio` | top-level vdev is a mirror (or a replacing / spare vdev) | scrub_repair, resilver, dtl_record, rebuild |
| E050 | `st_vdev_io_start` | `vdev_raidz` | `zio` | top-level vdev is raidz / dRAID | scrub_repair, resilver, rebuild |
| E051 | `vdev_mirror` | `vdev_child_io` | `zio` | scrub, not resilvering: a read to every readable child, each into its own buffer | scrub_repair |
| E052 | `vdev_mirror` | `dtl_query` | `dtl` | vdev_mirror_child_select(): a child whose DTL_MISSING has the block's txg is skipped (ESTALE); a rebuild read prefers children with an empty DTL | resilver, rebuild |
| E053 | `vdev_mirror` | `vdev_child_io` | `zio` | resilver or rebuild: one read, to the least-loaded child that has the data | resilver, rebuild |
| E054 | `vdev_raidz` | `dtl_query` | `dtl` | vdev_raidz_io_start_read_row() (dRAID: vdev_draid_io_start_read() with vdev_draid_missing()): a column on a child whose DTL_MISSING has this txg is skipped (ESTALE) and counted missing | resilver, rebuild |
| E055 | `vdev_raidz` | `vdev_child_io` | `zio` | scrub or resilver: read every data and parity column not skipped; the children carry no bp | scrub_repair, resilver, rebuild |
| E056 | `st_vdev_io_start` | `vdev_queue` | `zio` | leaf: vdev_queue_io() at the zio's priority: scrub, rebuild, or async write for a repair | scrub_repair, resilver, dtl_record, rebuild |
| E057 | `vdev_queue` | `vdev_leaf` | `zio` | vdev_queue_io_to_issue(): scrub and rebuild classes limited by vdev_queue_class_max_active() (min_active and nia credit while interactive I/O is active) | scrub_repair, resilver, dtl_record, rebuild |
| E058 | `vdev_leaf` | `dev_normal` | `bio` | submit_bio() (Linux) / g_io_request() (FreeBSD) | scrub_repair, resilver, dtl_record, rebuild |
| E059 | `dev_normal` | `vdev_intr` | `bio` | bio completion | scrub_repair, resilver, dtl_record, rebuild |
| E060 | `vdev_intr` | `zio_taskq` | `zio` | vbio_completion() / vdev_geom_io_intr() -> zio_interrupt(): onto an interrupt taskq | scrub_repair, resilver, dtl_record, rebuild |
| E061 | `zio_taskq` | `st_vdev_io_done` | `zio` | an interrupt-taskq worker resumes the pipeline | scrub_repair, resilver, dtl_record, rebuild |
| E062 | `st_vdev_io_done` | `vdev_queue` | `ctl` | vdev_queue_io_done(): slot freed, the next queued I/O issued | scrub_repair, resilver, rebuild |
| E063 | `st_vdev_io_done` | `st_vdev_io_assess` | `zio` | result of this vdev level | scrub_repair, resilver, dtl_record, rebuild |
| E064 | `st_vdev_io_assess` | `st_cksum_verify` | `abd` | read with a bp (mirror side, plain disk): data arrived | scrub_repair, resilver, rebuild |
| E065 | `st_cksum_verify` | `st_done` | `abd` | zio_checksum_error(): match, or ECKSUM: vs_checksum_errors++ and zfs_ereport_start_checksum(); the error stays in this child | scrub_repair, resilver, rebuild |
| E066 | `st_done` | `st_vdev_io_done` | `ctl` | child done: zio_notify_parent() lets the parent continue in VDEV_IO_DONE | scrub_repair, resilver, dtl_record, rebuild |
| E067 | `st_vdev_io_done` | `vdev_mirror` | `zio` | vdev_mirror_io_done(): no good copy yet: read another child; scrub: a verified buffer becomes the result; with a good copy, repair children that failed and, for a resilver, children whose DTL_PARTIAL has the txg | scrub_repair, resilver, rebuild |
| E068 | `vdev_mirror` | `vdev_child_io` | `zio` | repair write of the good data: ZIO_FLAG_IO_REPAIR (+ SELF_HEAL after an unexpected error), async write priority (rebuild priority for a rebuild) | scrub_repair, resilver, rebuild |
| E069 | `st_vdev_io_done` | `vdev_raidz` | `zio` | vdev_raidz_io_done(): rebuild known-missing columns, raidz_checksum_verify(); on failure read all columns and try combinations (vdev_raidz_combrec()); on success raidz_parity_verify() checks unused parity | scrub_repair, resilver, rebuild |
| E070 | `vdev_raidz` | `vdev_child_io` | `zio` | vdev_raidz_io_done_verified(): repair write of every wrong or skipped column, ZIO_FLAG_IO_REPAIR (+ SELF_HEAL), async write or rebuild priority | scrub_repair, resilver, rebuild |
| E071 | `st_vdev_io_start` | `dtl_query` | `dtl` | repair write without SELF_HEAL to a vdev whose DTL_PARTIAL lacks the txg: zio_vdev_io_bypass(), nothing is written | resilver |
| E072 | `st_done` | `vdev_stats` | `ctl` | zio_done() -> vdev_stat_update(zio, psize) | scrub_repair, resilver, dtl_record, rebuild |
| E073 | `vdev_stats` | `scan_state` | `scan` | successful repair write by the scan thread on a leaf: scn_processed += psize ("repaired" / "resilvered") | scrub_repair, resilver |
| E074 | `vdev_stats` | `dtl_dirty` | `dtl` | failed write in txg N (ENXIO, or any error on a retried I/O; an EIO that was not retried is ignored): vdev_dtl_dirty(leaf, DTL_MISSING, N), DTL_PARTIAL up the tree, vdev_dirty(VDD_DTL); a failed scan repair also adds DTL_SCRUB | dtl_record |
| E075 | `dtl_dirty` | `dtl_sync` | `dtl` | the leaf is on its top-level vdev's vdev_dtl_list for the commit txg (vdev_dirty()) | dtl_record |
| E076 | `spa_sync` | `dtl_sync` | `dtl` | vdev_sync() for each dirty top-level vdev -> vdev_dtl_sync(): DTL_MISSING rewritten into its space map | dtl_record, scan_complete |
| E077 | `st_vdev_io_start` | `zio_taskq` | `zio` | leaf not accessible (offline, faulted, removed): io_error = ENXIO and zio_interrupt(), no disk I/O | dtl_record |
| E078 | `st_vdev_io_assess` | `st_done` | `zio` | write, raidz column read, or failed leaf I/O: this level is finished (an error becomes ENXIO when the device is no longer accessible) | scrub_repair, resilver, dtl_record, rebuild |
| E079 | `vdev_mirror` | `vdev_child_io` | `zio` | write: a child zio for every child, offline ones included | dtl_record |
| E080 | `st_vdev_io_done` | `vdev_mirror` | `zio` | vdev_mirror_io_done() for a write: some children failing is still success; a logical write with a failed DVA, or with no good child, fails | dtl_record |
| E081 | `vdev_open_assess` | `dtl_query` | `dtl` | dsl_scan_assess_vdev(): vdev_resilver_needed(leaf): DTL_MISSING not empty and the device writable, with its min and max txg | resilver, resilver_defer |
| E082 | `vdev_open_assess` | `spa_async` | `ctl` | no resilver running, or resilver_defer not enabled: spa_async_request(SPA_ASYNC_RESILVER) | resilver |
| E083 | `vdev_open_assess` | `resilver_defer` | `ctl` | a resilver is running and this leaf's DTL ends after its scn_max_txg, resilver_defer enabled: vdev_defer_resilver() | resilver_defer |
| E084 | `spa_async` | `dsl_scan_entry` | `ctl` | spa_async_thread(): SPA_ASYNC_RESILVER, no rebuild active, and no resilver running or resilver_defer disabled: dsl_scan_restart_resilver(dp, 0) | resilver, resilver_defer |
| E085 | `dsl_scan_entry` | `scan_sync` | `scan` | dsl_scan_restart_resilver(): scn_restart_txg = the txg of a new tx (or the txg given by attach) | resilver, resilver_defer |
| E086 | `scan_sync` | `scan_setup` | `ctl` | scn_restart_txg reached, or a deferred resilver restarting early: dsl_scan_done(cancel), then dsl_scan_setup_sync() as a resilver if vdev_resilver_needed(), else as a scrub | resilver, resilver_defer |
| E087 | `ioc_attach` | `dtl_dirty` | `dtl` | spa_vdev_attach(): vdev_dtl_dirty(newvd, DTL_MISSING, TXG_INITIAL to the attach txg): the new device has nothing yet | resilver, resilver_defer, rebuild |
| E088 | `ioc_attach` | `dsl_scan_entry` | `ctl` | healing resilver: newvd->vdev_resilver_txg = txg; dsl_scan_restart_resilver(dp, dtl_max_txg) | resilver |
| E089 | `ioc_attach` | `resilver_defer` | `ctl` | a resilver is already running and resilver_defer is enabled: vdev_defer_resilver(newvd) | resilver_defer |
| E090 | `ioc_attach` | `rebuild_start` | `ctl` | -s: newvd->vdev_rebuild_txg = txg; vdev_rebuild(top-level vdev, txg) | rebuild |
| E091 | `zpool_attach_cmd` | `libzfs_scan` | `ctl` | zpool_do_attach_or_replace(): -s sets rebuild; zpool_vdev_attach(zhp, old, new, nvroot, replacing, rebuild) | resilver, resilver_defer, rebuild |
| E092 | `libzfs_scan` | `ioc_attach` | `ctl` | ZFS_IOC_VDEV_ATTACH with zc_simple = rebuild; zfs_ioc_vdev_attach() -> spa_vdev_attach() | resilver, resilver_defer, rebuild |
| E093 | `scan_sync` | `resilver_defer` | `ctl` | spa_resilver_deferred: the resilver_defer feature is activated; the running resilver restarts at once instead if zfs_resilver_disable_defer is set or less than zfs_resilver_defer_percent of it is issued | resilver_defer |
| E094 | `scan_done` | `resilver_defer` | `ctl` | vdev_clear_resilver_deferred(): clears every leaf's flag and deactivates the feature; true if a leaf still needs resilver | resilver_defer, scan_complete |
| E095 | `scan_done` | `spa_async` | `ctl` | spa_async_request(SPA_ASYNC_RESILVER_DONE); also SPA_ASYNC_RESILVER when a deferred resilver is due | resilver_defer, scan_complete |
| E096 | `dtl_reassess` | `resilver_defer` | `ctl` | vdev_dtl_should_excise(): a deferred leaf keeps its DTL_MISSING | resilver_defer |
| E097 | `scan_sync` | `scan_done` | `ctl` | traversal finished (scn_done_txg reached) and no sios pending: dsl_scan_done(scn, B_TRUE), state written with SYNC_MANDATORY | resilver_defer, scan_complete |
| E098 | `scan_visit` | `scan_sync` | `scan` | dataset queue empty: bookmark set to ZB_DESTROYED_OBJSET; dsl_scan_sync() sets scn_done_txg and starts a checkpoint to drain the queues | scan_complete |
| E099 | `scan_done` | `dtl_reassess` | `dtl` | vdev_dtl_reassess(root, txg, scn_max_txg, scrub_done) when complete (and no pool checkpoint); scrub_txg 0 when cancelled: DTLs kept, DTL_SCRUB emptied | resilver_defer, pause_cancel, scan_complete |
| E100 | `dtl_reassess` | `dtl_sync` | `dtl` | leaf DTL_MISSING below scrub_txg replaced by DTL_SCRUB (space_reftree); vdev_dirty(VDD_DTL) so it is written in this txg | resilver_defer, rebuild, scan_complete |
| E101 | `scan_done` | `scan_state` | `scan` | DSS_FINISHED or DSS_CANCELED, end time; a completed scrub stores DMU_POOL_LAST_SCRUBBED_TXG (used by -C); spa_errlog_rotate() | scan_complete |
| E102 | `spa_async` | `resilver_done` | `ctl` | SPA_ASYNC_RESILVER_DONE or SPA_ASYNC_REBUILD_DONE: spa_vdev_resilver_done() | rebuild, scan_complete |
| E103 | `resilver_done` | `dtl_query` | `dtl` | spa_vdev_resilver_done_hunt(): new child with empty DTL_MISSING and DTL_OUTAGE, and the old child not required (vdev_dtl_required()): spa_vdev_detach() it | rebuild, scan_complete |
| E104 | `rebuild_start` | `dtl_query` | `dtl` | vdev_rebuild_initiate_sync(): vdev_resilver_needed(top-level vdev) gives vrp_min_txg and vrp_max_txg | rebuild |
| E105 | `rebuild_start` | `rebuild_thread` | `ctl` | sync task vdev_rebuild_initiate_sync(): feature device_rebuild active, thread_create(vdev_rebuild_thread); a running rebuild is reset instead (vdev_rebuild_reset_wanted) | rebuild |
| E106 | `rebuild_thread` | `dsl_scan_entry` | `ctl` | a scrub in progress is cancelled: dsl_scan_cancel() | rebuild |
| E107 | `rebuild_thread` | `rebuild_range` | `scan` | per metaslab: metaslab_disable(), wait for sync, allocated ranges from space_map_load(SM_ALLOC) plus unflushed changes; vdev_rebuild_ranges() cuts them into chunks of up to zfs_rebuild_max_segment | rebuild |
| E108 | `rebuild_range` | `dtl_query` | `dtl` | vdev_dtl_need_resilver(dva, TXG_UNKNOWN): a chunk no child needs is skipped (mirror: always needed; dRAID checks the children of the range) | rebuild |
| E109 | `rebuild_range` | `zio_create` | `zio` | zio_read() of a made-up bp (one DVA = the chunk, birth TXG_INITIAL, checksum and compression off), ZIO_PRIORITY_REBUILD, RAW + CANFAIL + RESILVER; at most zfs_rebuild_vdev_limit x children bytes in flight | rebuild |
| E110 | `st_done` | `rebuild_range` | `ctl` | done callback vdev_rebuild_cb(): in-flight bytes released; errors counted in vrp_errors | rebuild |
| E111 | `rebuild_thread` | `rebuild_done` | `ctl` | all metaslabs done without error: dsl_sync_task_nowait(vdev_rebuild_complete_sync) | rebuild |
| E112 | `rebuild_done` | `dtl_reassess` | `dtl` | vdev_dtl_reassess(vd, txg, vrp_max_txg, scrub_done, rebuild_done): DTL_MISSING up to vrp_max_txg excised when vrp_errors is 0 | rebuild |
| E113 | `rebuild_done` | `spa_async` | `ctl` | spa_async_request(SPA_ASYNC_REBUILD_DONE): detach the replaced device or spare | rebuild |
| E114 | `rebuild_done` | `scan_setup` | `ctl` | dsl_scan_setup_check() passes and zfs_rebuild_scrub_enabled: dsl_scan_setup_sync(POOL_SCAN_SCRUB) in the same sync task | rebuild |
| E115 | `spa_sync` | `scan_ctl_sync` | `ctl` | dsl_pool_sync() runs the task: pause sets DSF_SCRUB_PAUSED, resume clears it, cancel calls dsl_scan_done(scn, B_FALSE); the check functions return ENOENT or EBUSY when there is nothing to do | pause_cancel |
| E116 | `scan_ctl_sync` | `scan_state` | `scan` | pause and resume: dsl_scan_sync_state(SYNC_CACHED) rewrites the last consistent scn_phys with the new flag; cancel: SYNC_MANDATORY | pause_cancel |
| E117 | `scan_ctl_sync` | `scan_done` | `ctl` | cancel: dsl_scan_done(scn, B_FALSE): sorted queues destroyed, DTLs kept | pause_cancel |
| E118 | `scan_sync` | `txg_sync` | `ctl` | paused: dsl_scan_sync() returns before scanning and dsl_scan_active() is false, so txgs return to the zfs_txg_timeout rhythm | pause_cancel |
| E119 | `spa_sync` | `errscrub_sync` | `ctl` | dsl_errorscrub_sync(dp, tx) after dsl_scan_sync(), pass 1 only; a running resilver cancels the error scrub | error_scrub |
| E120 | `errscrub_sync` | `errscrub_read` | `bp` | per error-log entry (with head_errlog per affected head dataset and snapshot, scrub_filesystem()): read_by_block_level(), until zfs_scrub_error_blocks_per_txg blocks or the time limit | error_scrub |
| E121 | `errscrub_read` | `scan_exec_io` | `bp` | dbuf_dnode_findbp() gives the current bp; scan_exec_io(ZIO_FLAG_SCRUB, no queue) | error_scrub |
| E122 | `errscrub_sync` | `scan_state` | `scan` | dsl_errorscrub_sync_state(): cursor and counters to the pool directory; log finished: dsl_errorscrub_done() rotates the error log | error_scrub |
| E123 | `admin` | `zpool_scrub_cmd` | `ctl` | runs zpool scrub [-s | -p | -e] pool, or zpool resilver pool | scrub_start, pause_cancel, error_scrub |
| E124 | `admin` | `zpool_attach_cmd` | `ctl` | runs zpool attach [-s] or zpool replace [-s] pool device new-device | rebuild |

## 10. Paths

11 named paths, 300 steps in total. Each step is one wire; the caption for a step is that wire's label. Every wire in section 9 is on at least one path. Step syntax and alternatives are defined in section 10 of `../zfs-io-flow-diagram-spec.md`.

### 10.1 `scrub_start` - Starting a scrub

Category: Start. `zpool scrub tank`: the request goes through libzfs and the ioctl to dsl_scan(), which probes every device and queues a sync task; in the next txg the task resets the scan state. No block is read on this path.

```
 1  E123  admin -> zpool_scrub_cmd
 2  E001  zpool_scrub_cmd -> libzfs_scan  "zpool scrub tank"
 3  E002  libzfs_scan -> ioc_scrub
 4  E003  ioc_scrub -> spa_scan  "no -p or -s: spa_scan_range(), here without a txg range"
 5  E004  spa_scan -> dsl_scan_entry  "dsl_scan(POOL_SCAN_SCRUB)"
 6  E005  dsl_scan_entry -> vdev_open_assess
 7  E006  dsl_scan_entry -> txg_sync  "dsl_sync_task(dsl_scan_setup_check, dsl_scan_setup_sync)"
 8  E007  txg_sync -> spa_sync
 9  E008  spa_sync -> scan_setup
10  E009  scan_setup -> dtl_query  "no leaf has a DTL: the range stays (0, this txg)"
11  E010  scan_setup -> scan_state
12  E042  scan_state -> zpool_status  "zpool status: scrub in progress, 0 scanned"
```
Ends: scn_phys says DSS_SCANNING on disk. From the next txg dsl_scan_sync() does the work: path scan_txg.

### 10.2 `scan_txg` - One txg of metadata traversal

Category: Scan. What one txg of traversal does: walk the DDT, the MOS and each dataset's block tree depth first, reading metadata through the ARC with a prefetch thread ahead of it, and turn every block in range into a queued read, until the time slice ends.

Alternatives:
- `mode`: `sorted` Sorted scan (default); `legacy` Legacy scan (zfs_scan_legacy=1) or a gang block: read at once

```
 1  E007  txg_sync -> spa_sync  "a scan is active: no idle wait between txgs"
 2  E011  spa_sync -> scan_sync
 3  E012  scan_sync -> scan_visit
 4  E013  scan_sync -> scan_prefetch
 5  E014  scan_visit -> scan_ddt  "only until the DDT classes are done"
 6  E015  scan_ddt -> scrub_cb
 7  E016  scan_visit -> scan_visitbp
 8  E017  scan_visit -> scan_prefetch
 9  E022  scan_prefetch -> arc_read
10  E023  arc_read -> scan_prefetch
11  E018  scan_visitbp -> scan_suspend
12  E020  scan_visitbp -> arc_read
13  E021  arc_read -> scan_visitbp
14  E024  scan_visitbp -> scrub_cb
15  E029  scrub_cb -> scan_enqueue
16  E030  scan_enqueue -> scan_queue  [mode: sorted]
17  E031  scan_enqueue -> scan_exec_io  [mode: legacy]
18  E039  scan_exec_io -> zio_create  [mode: legacy]  "the read is issued during the traversal, in logical order"
19  E018  scan_visitbp -> scan_suspend  "time is up"
20  E019  scan_suspend -> scan_visitbp
21  E032  scan_sync -> scan_state
```
Ends: The bookmark is in memory; it reaches disk at the next checkpoint. The next txg continues from it, or issues the queues instead (path sorted_issue).

### 10.3 `sorted_issue` - Issuing the sorted queues

Category: Scan. When the queues hold too much memory, at a checkpoint, or after traversal ends, a txg is spent issuing queued reads instead of traversing: one thread per top-level vdev takes extents and issues their blocks in disk-offset order.

```
 1  E007  txg_sync -> spa_sync
 2  E011  spa_sync -> scan_sync
 3  E033  scan_sync -> scan_queue  "queue memory reached the hard limit: clearing starts"
 4  E034  scan_sync -> queues_run
 5  E035  scan_queue -> queues_run
 6  E036  queues_run -> scan_suspend
 7  E038  queues_run -> scan_exec_io
 8  E039  scan_exec_io -> zio_create
 9  E040  st_done -> scan_exec_io  "after the read (path scrub_repair)"
10  E037  queues_run -> scan_queue  "the time slice ended inside an extent"
11  E041  st_free -> scan_queue  "meanwhile a queued block is freed"
12  E032  scan_sync -> scan_state  "queues not empty: scn_phys on disk stays at the last checkpoint"
13  E042  scan_state -> zpool_status  "zpool status: issued grows; the estimate uses the issue rate"
```
Ends: Memory is back under the soft limit; the next txg traverses again. This alternation is why "scanned" runs ahead of "issued".

### 10.4 `scrub_repair` - Scrub read finds a bad copy and repairs it

Category: Repair. A queued block is read. The scrub reads every copy: every mirror side, or every raidz column including parity. One copy fails its checksum; the good data is written back over it and counted as repaired.

Alternatives:
- `layout`: `mirror` Mirror top-level vdev: a mirror side has bad data; `raidz` RAIDZ / dRAID top-level vdev: one column has bad data

```
 1  E039  scan_exec_io -> zio_create
 2  E043  zio_create -> st_read_bp_init
 3  E044  st_read_bp_init -> st_ready
 4  E045  st_ready -> st_vdev_io_start
 5  E046  st_vdev_io_start -> vdev_dva_fanout
 6  E047  vdev_dva_fanout -> vdev_child_io
 7  E048  vdev_child_io -> st_vdev_io_start
 8  E049  st_vdev_io_start -> vdev_mirror  [layout: mirror]
 9  E051  vdev_mirror -> vdev_child_io  [layout: mirror]
10  E048  vdev_child_io -> st_vdev_io_start  [layout: mirror]
11  E050  st_vdev_io_start -> vdev_raidz  [layout: raidz]
12  E055  vdev_raidz -> vdev_child_io  [layout: raidz]
13  E048  vdev_child_io -> st_vdev_io_start  [layout: raidz]
14  E056  st_vdev_io_start -> vdev_queue  "scrub class"
15  E057  vdev_queue -> vdev_leaf
16  E058  vdev_leaf -> dev_normal
17  E059  dev_normal -> vdev_intr
18  E060  vdev_intr -> zio_taskq
19  E061  zio_taskq -> st_vdev_io_done
20  E062  st_vdev_io_done -> vdev_queue
21  E063  st_vdev_io_done -> st_vdev_io_assess
22  E064  st_vdev_io_assess -> st_cksum_verify  [layout: mirror]
23  E065  st_cksum_verify -> st_done  [layout: mirror]  "one side does not match: ECKSUM in that child"
24  E078  st_vdev_io_assess -> st_done  [layout: raidz]  "column reads finish; raidz checks the checksum itself"
25  E066  st_done -> st_vdev_io_done
26  E067  st_vdev_io_done -> vdev_mirror  [layout: mirror]  "the other side verified: its buffer is the result, the bad side is repaired"
27  E068  vdev_mirror -> vdev_child_io  [layout: mirror]
28  E069  st_vdev_io_done -> vdev_raidz  [layout: raidz]  "checksum fails; combinatorial reconstruction finds the bad column"
29  E070  vdev_raidz -> vdev_child_io  [layout: raidz]
30  E048  vdev_child_io -> st_vdev_io_start  "the repair write enters VDEV_IO_START on the bad disk"
31  E056  st_vdev_io_start -> vdev_queue  "async write class"
32  E057  vdev_queue -> vdev_leaf
33  E058  vdev_leaf -> dev_normal
34  E059  dev_normal -> vdev_intr
35  E060  vdev_intr -> zio_taskq
36  E061  zio_taskq -> st_vdev_io_done
37  E063  st_vdev_io_done -> st_vdev_io_assess
38  E078  st_vdev_io_assess -> st_done
39  E072  st_done -> vdev_stats
40  E073  vdev_stats -> scan_state  "counted as repaired"
41  E066  st_done -> st_vdev_io_done
42  E040  st_done -> scan_exec_io  "the logical read succeeded: no scan error"
```
Ends: The bad copy is rewritten in place, its device shows a checksum error, and zpool status shows the bytes as repaired. Without a good copy the read fails, scn_errors grows and the block appears in zpool status -v.

### 10.5 `resilver` - Resilver of a device that missed writes

Category: Resilver. A device comes back (zpool online, clear or reopen) after missing some txgs, or a device is replaced. A resilver starts, the traversal selects only blocks whose birth txg is in a DTL, and each is read from a good copy and written to the device that lacks it.

Alternatives:
- `trigger`: `reopen` A device that was offline comes back; `replace` zpool replace / zpool attach (healing resilver)
- `layout`: `mirror` Mirror top-level vdev; `raidz` RAIDZ / dRAID top-level vdev

```
 1  E081  vdev_open_assess -> dtl_query  [trigger: reopen]  "vdev_open() of the returning disk"
 2  E082  vdev_open_assess -> spa_async  [trigger: reopen]
 3  E084  spa_async -> dsl_scan_entry  [trigger: reopen]
 4  E091  zpool_attach_cmd -> libzfs_scan  [trigger: replace]  "zpool replace tank old new"
 5  E092  libzfs_scan -> ioc_attach  [trigger: replace]
 6  E087  ioc_attach -> dtl_dirty  [trigger: replace]
 7  E088  ioc_attach -> dsl_scan_entry  [trigger: replace]
 8  E085  dsl_scan_entry -> scan_sync
 9  E011  spa_sync -> scan_sync
10  E086  scan_sync -> scan_setup
11  E009  scan_setup -> dtl_query  "the DTLs give the txg range"
12  E010  scan_setup -> scan_state
13  E012  scan_sync -> scan_visit
14  E016  scan_visit -> scan_visitbp
15  E020  scan_visitbp -> arc_read
16  E021  arc_read -> scan_visitbp
17  E024  scan_visitbp -> scrub_cb
18  E025  scrub_cb -> need_resilver
19  E026  need_resilver -> dtl_query
20  E027  need_resilver -> resilver_defer
21  E028  need_resilver -> scrub_cb
22  E029  scrub_cb -> scan_enqueue
23  E030  scan_enqueue -> scan_queue
24  E034  scan_sync -> queues_run  "the queues are issued (path sorted_issue)"
25  E035  scan_queue -> queues_run
26  E038  queues_run -> scan_exec_io
27  E039  scan_exec_io -> zio_create
28  E043  zio_create -> st_read_bp_init
29  E044  st_read_bp_init -> st_ready
30  E045  st_ready -> st_vdev_io_start
31  E046  st_vdev_io_start -> vdev_dva_fanout
32  E047  vdev_dva_fanout -> vdev_child_io
33  E048  vdev_child_io -> st_vdev_io_start
34  E049  st_vdev_io_start -> vdev_mirror  [layout: mirror]
35  E052  vdev_mirror -> dtl_query  [layout: mirror]  "the stale side is not read"
36  E053  vdev_mirror -> vdev_child_io  [layout: mirror]
37  E048  vdev_child_io -> st_vdev_io_start  [layout: mirror]
38  E050  st_vdev_io_start -> vdev_raidz  [layout: raidz]
39  E054  vdev_raidz -> dtl_query  [layout: raidz]  "the stale disk's column is not read"
40  E055  vdev_raidz -> vdev_child_io  [layout: raidz]
41  E048  vdev_child_io -> st_vdev_io_start  [layout: raidz]
42  E056  st_vdev_io_start -> vdev_queue
43  E057  vdev_queue -> vdev_leaf
44  E058  vdev_leaf -> dev_normal
45  E059  dev_normal -> vdev_intr
46  E060  vdev_intr -> zio_taskq
47  E061  zio_taskq -> st_vdev_io_done
48  E062  st_vdev_io_done -> vdev_queue
49  E063  st_vdev_io_done -> st_vdev_io_assess
50  E064  st_vdev_io_assess -> st_cksum_verify  [layout: mirror]
51  E065  st_cksum_verify -> st_done  [layout: mirror]
52  E078  st_vdev_io_assess -> st_done  [layout: raidz]
53  E066  st_done -> st_vdev_io_done
54  E067  st_vdev_io_done -> vdev_mirror  [layout: mirror]  "good copy: write it to the side whose DTL has this txg"
55  E068  vdev_mirror -> vdev_child_io  [layout: mirror]
56  E069  st_vdev_io_done -> vdev_raidz  [layout: raidz]  "the skipped column is rebuilt from parity and the checksum verified"
57  E070  vdev_raidz -> vdev_child_io  [layout: raidz]
58  E048  vdev_child_io -> st_vdev_io_start
59  E071  st_vdev_io_start -> dtl_query  "the stale disk's DTL_PARTIAL has the txg: not bypassed"
60  E056  st_vdev_io_start -> vdev_queue
61  E057  vdev_queue -> vdev_leaf
62  E058  vdev_leaf -> dev_normal
63  E059  dev_normal -> vdev_intr
64  E060  vdev_intr -> zio_taskq
65  E061  zio_taskq -> st_vdev_io_done
66  E063  st_vdev_io_done -> st_vdev_io_assess
67  E078  st_vdev_io_assess -> st_done
68  E072  st_done -> vdev_stats
69  E073  vdev_stats -> scan_state  "counted as resilvered"
```
Ends: Every block born in the DTL range has been rewritten on the device. When the queues drain the scan completes and the DTL is cleared: path scan_complete.

### 10.6 `dtl_record` - A device misses writes: recording the DTL

Category: DTL. A txg's write reaches a mirror while one side cannot take it. The write still succeeds through the other side, and the failed child records the txg in the leaf's DTL, which is written to disk in the same txg.

Alternatives:
- `cause`: `offline` Device offline, faulted or removed before the write; `lost` Device disappears during the write (the Linux driver sees EIO, finds the disk gone and sets vdev_remove_wanted)

```
 1  E045  st_ready -> st_vdev_io_start  "a txg sync write (I/O graph path txg_sync) reaches the vdev layer"
 2  E046  st_vdev_io_start -> vdev_dva_fanout
 3  E047  vdev_dva_fanout -> vdev_child_io
 4  E048  vdev_child_io -> st_vdev_io_start
 5  E049  st_vdev_io_start -> vdev_mirror
 6  E079  vdev_mirror -> vdev_child_io
 7  E048  vdev_child_io -> st_vdev_io_start
 8  E056  st_vdev_io_start -> vdev_queue
 9  E077  st_vdev_io_start -> zio_taskq  [cause: offline]
10  E057  vdev_queue -> vdev_leaf  [cause: lost]
11  E058  vdev_leaf -> dev_normal  [cause: lost]
12  E059  dev_normal -> vdev_intr  [cause: lost]  "the bio fails with EIO"
13  E060  vdev_intr -> zio_taskq  [cause: lost]
14  E061  zio_taskq -> st_vdev_io_done
15  E063  st_vdev_io_done -> st_vdev_io_assess
16  E078  st_vdev_io_assess -> st_done  "ENXIO for this child"
17  E072  st_done -> vdev_stats
18  E074  vdev_stats -> dtl_dirty
19  E075  dtl_dirty -> dtl_sync
20  E076  spa_sync -> dtl_sync
21  E066  st_done -> st_vdev_io_done
22  E080  st_vdev_io_done -> vdev_mirror  "the other side has it: the write succeeds"
```
Ends: The leaf's DTL_MISSING holds the txg on disk. When the device returns, path resilver reads exactly the blocks born in such txgs. A plain EIO from a disk that is still present is not recorded in the DTL; it is left to scrubs and fault management.

### 10.7 `resilver_defer` - A second device needs resilver during a resilver

Category: Resilver. With the resilver_defer feature, a device that needs resilver while one is running does not restart it. The running resilver keeps its txg range and finishes (it may repair some of the deferred device's blocks along the way), the deferred device keeps its DTL, and a second resilver starts for it.

Alternatives:
- `trigger`: `reopen` Another device comes back; `attach` zpool attach or replace during the resilver

```
 1  E081  vdev_open_assess -> dtl_query  [trigger: reopen]
 2  E083  vdev_open_assess -> resilver_defer  [trigger: reopen]
 3  E091  zpool_attach_cmd -> libzfs_scan  [trigger: attach]
 4  E092  libzfs_scan -> ioc_attach  [trigger: attach]
 5  E087  ioc_attach -> dtl_dirty  [trigger: attach]
 6  E089  ioc_attach -> resilver_defer  [trigger: attach]
 7  E093  scan_sync -> resilver_defer  "a resilver below zfs_resilver_defer_percent would restart now instead"
 8  E025  scrub_cb -> need_resilver
 9  E027  need_resilver -> resilver_defer  "a top-level vdev whose leaves are all deferred is skipped"
10  E097  scan_sync -> scan_done  "the running resilver finishes"
11  E099  scan_done -> dtl_reassess
12  E096  dtl_reassess -> resilver_defer
13  E100  dtl_reassess -> dtl_sync
14  E094  scan_done -> resilver_defer
15  E095  scan_done -> spa_async  "SPA_ASYNC_RESILVER"
16  E084  spa_async -> dsl_scan_entry
17  E085  dsl_scan_entry -> scan_sync
18  E086  scan_sync -> scan_setup  "the second resilver starts"
```
Ends: A new resilver runs for the deferred device. Without the feature (or with zfs_resilver_disable_defer) the first resilver would have restarted from the beginning instead.

### 10.8 `rebuild` - Sequential rebuild (zpool attach -s / replace -s)

Category: Rebuild. A rebuild copies all allocated space of one top-level vdev in LBA order, without block pointers or checksums, reading from children that have the data and writing to the new device; then a scrub verifies.

Alternatives:
- `layout`: `mirror` Mirror top-level vdev; `draid` dRAID top-level vdev (distributed spare)

```
 1  E124  admin -> zpool_attach_cmd
 2  E091  zpool_attach_cmd -> libzfs_scan  "zpool replace -s tank old new"
 3  E092  libzfs_scan -> ioc_attach
 4  E087  ioc_attach -> dtl_dirty
 5  E090  ioc_attach -> rebuild_start
 6  E105  rebuild_start -> rebuild_thread
 7  E104  rebuild_start -> dtl_query
 8  E106  rebuild_thread -> dsl_scan_entry  "only if a scrub is running"
 9  E107  rebuild_thread -> rebuild_range
10  E108  rebuild_range -> dtl_query
11  E109  rebuild_range -> zio_create
12  E043  zio_create -> st_read_bp_init
13  E044  st_read_bp_init -> st_ready
14  E045  st_ready -> st_vdev_io_start
15  E046  st_vdev_io_start -> vdev_dva_fanout
16  E047  vdev_dva_fanout -> vdev_child_io
17  E048  vdev_child_io -> st_vdev_io_start
18  E049  st_vdev_io_start -> vdev_mirror  [layout: mirror]
19  E052  vdev_mirror -> dtl_query  [layout: mirror]  "a child with an empty DTL is preferred"
20  E053  vdev_mirror -> vdev_child_io  [layout: mirror]
21  E048  vdev_child_io -> st_vdev_io_start  [layout: mirror]
22  E050  st_vdev_io_start -> vdev_raidz  [layout: draid]
23  E054  vdev_raidz -> dtl_query  [layout: draid]
24  E055  vdev_raidz -> vdev_child_io  [layout: draid]
25  E048  vdev_child_io -> st_vdev_io_start  [layout: draid]
26  E056  st_vdev_io_start -> vdev_queue  "rebuild class"
27  E057  vdev_queue -> vdev_leaf
28  E058  vdev_leaf -> dev_normal
29  E059  dev_normal -> vdev_intr
30  E060  vdev_intr -> zio_taskq
31  E061  zio_taskq -> st_vdev_io_done
32  E062  st_vdev_io_done -> vdev_queue
33  E063  st_vdev_io_done -> st_vdev_io_assess
34  E064  st_vdev_io_assess -> st_cksum_verify  [layout: mirror]
35  E065  st_cksum_verify -> st_done  [layout: mirror]  "the made-up bp has checksum off: nothing is verified"
36  E078  st_vdev_io_assess -> st_done  [layout: draid]
37  E066  st_done -> st_vdev_io_done
38  E067  st_vdev_io_done -> vdev_mirror  [layout: mirror]
39  E068  vdev_mirror -> vdev_child_io  [layout: mirror]  "rebuild priority"
40  E069  st_vdev_io_done -> vdev_raidz  [layout: draid]  "no checksum: parity fills in the missing column"
41  E070  vdev_raidz -> vdev_child_io  [layout: draid]
42  E048  vdev_child_io -> st_vdev_io_start
43  E056  st_vdev_io_start -> vdev_queue
44  E057  vdev_queue -> vdev_leaf
45  E058  vdev_leaf -> dev_normal
46  E059  dev_normal -> vdev_intr
47  E060  vdev_intr -> zio_taskq
48  E061  zio_taskq -> st_vdev_io_done
49  E063  st_vdev_io_done -> st_vdev_io_assess
50  E078  st_vdev_io_assess -> st_done
51  E072  st_done -> vdev_stats
52  E066  st_done -> st_vdev_io_done
53  E110  st_done -> rebuild_range
54  E111  rebuild_thread -> rebuild_done
55  E112  rebuild_done -> dtl_reassess
56  E100  dtl_reassess -> dtl_sync
57  E113  rebuild_done -> spa_async
58  E102  spa_async -> resilver_done
59  E103  resilver_done -> dtl_query
60  E114  rebuild_done -> scan_setup
61  E010  scan_setup -> scan_state  "the verification scrub starts"
```
Ends: Redundancy is restored as soon as the rebuild ends; the scrub that follows (paths scan_txg, sorted_issue, scrub_repair) verifies every checksum.

### 10.9 `pause_cancel` - Pause, resume or cancel a scrub

Category: Control. `zpool scrub -p` pauses, `zpool scrub` on a paused scrub resumes, `zpool scrub -s` cancels. Each is a sync task. A pause keeps the bookmark and queues; a cancel throws the progress away.

Alternatives:
- `cmd`: `pause` zpool scrub -p; `resume` zpool scrub on a paused scrub; `cancel` zpool scrub -s

```
 1  E123  admin -> zpool_scrub_cmd
 2  E001  zpool_scrub_cmd -> libzfs_scan
 3  E002  libzfs_scan -> ioc_scrub
 4  E003  ioc_scrub -> spa_scan
 5  E004  spa_scan -> dsl_scan_entry
 6  E006  dsl_scan_entry -> txg_sync
 7  E007  txg_sync -> spa_sync
 8  E115  spa_sync -> scan_ctl_sync
 9  E116  scan_ctl_sync -> scan_state
10  E118  scan_sync -> txg_sync  [cmd: pause]
11  E011  spa_sync -> scan_sync  [cmd: resume]  "the scan continues from its bookmark"
12  E117  scan_ctl_sync -> scan_done  [cmd: cancel]
13  E099  scan_done -> dtl_reassess  [cmd: cancel]  "not complete: scrub_txg 0"
14  E042  scan_state -> zpool_status
```
Ends: Paused: no scan work until resumed (pause and stop are refused during a resilver). Cancelled: DSS_CANCELED, and a new scrub starts from the beginning.

### 10.10 `error_scrub` - Error scrub (zpool scrub -e)

Category: Scan. Instead of the whole pool, only the blocks in the last error log are read again, a limited number per txg. Blocks that now read correctly drop out of the error list when the log is rotated.

```
 1  E123  admin -> zpool_scrub_cmd
 2  E001  zpool_scrub_cmd -> libzfs_scan  "zpool scrub -e tank"
 3  E002  libzfs_scan -> ioc_scrub
 4  E003  ioc_scrub -> spa_scan
 5  E004  spa_scan -> dsl_scan_entry  "dsl_scan(POOL_SCAN_ERRORSCRUB)"
 6  E006  dsl_scan_entry -> txg_sync
 7  E007  txg_sync -> spa_sync
 8  E008  spa_sync -> scan_setup  "dsl_errorscrub_setup_sync(); ECANCELED if the error log is empty"
 9  E119  spa_sync -> errscrub_sync
10  E120  errscrub_sync -> errscrub_read
11  E121  errscrub_read -> scan_exec_io
12  E039  scan_exec_io -> zio_create
13  E040  st_done -> scan_exec_io  "after the read (path scrub_repair)"
14  E122  errscrub_sync -> scan_state
15  E042  scan_state -> zpool_status
```
Ends: The error scrub finishes when the log is exhausted; dep_errors counts blocks that still fail.

### 10.11 `scan_complete` - Completion: DTLs, stats and detach

Category: Completion. Traversal finished and the queues drained: the scan is marked done, every leaf's DTL is cut back to what could not be repaired, and a finished replacement is detached.

Alternatives:
- `kind`: `resilver` Resilver of a replacing vdev; `scrub` Scrub

```
 1  E098  scan_visit -> scan_sync
 2  E011  spa_sync -> scan_sync
 3  E034  scan_sync -> queues_run  "the remaining queues drain in LBA order (checkpoint)"
 4  E097  scan_sync -> scan_done
 5  E099  scan_done -> dtl_reassess
 6  E100  dtl_reassess -> dtl_sync
 7  E076  spa_sync -> dtl_sync
 8  E101  scan_done -> scan_state
 9  E094  scan_done -> resilver_defer  "with resilver_defer enabled"
10  E095  scan_done -> spa_async
11  E102  spa_async -> resilver_done
12  E103  resilver_done -> dtl_query  [kind: resilver]  "the old disk is detached; zpool replace is complete"
13  E042  scan_state -> zpool_status
```
Ends: zpool status shows the scan finished with its repaired or resilvered bytes and error count; a replaced disk is gone from the config.

## 11. Accuracy rules and known simplifications

Rules: the same as section 11 of `../zfs-io-flow-diagram-spec.md`. OS-specific pieces use Linux names with the FreeBSD equivalent where it differs.

Simplifications made on purpose. State these in the page's About overlay:

1. The shared zio and vdev nodes show only the stages scan I/O uses. Gang blocks, embedded block pointers and dedup reads are not drawn; gang blocks are read during the traversal and never queued.
2. Async destroys, the ZIL scan (dsl_scan_zil()) and the DDT walk's interaction with dedup reference changes run inside dsl_scan_sync() but are only mentioned in node text.
3. Indirect blocks are both traversed (read through the ARC) and handed to the scan callback, so they are verified like data; the paths show one data block.
4. Extra copies (copies=2/3, metadata ditto blocks) each get their own queued read; repair from another DVA uses the same DVA fan-out as the I/O graph and is not drawn as a separate alternative.
5. dRAID is folded into the raidz node; distributed spares, dRAID-specific DTL checks and raidz expansion are left out.
6. Dataset changes during a scan (destroy, new snapshot, clone swap) adjust the saved bookmark and queue; they are not drawn.
7. A pool checkpoint stops a completed scrub or resilver from excising DTLs; a rebuild still does. Device removal (indirect vdevs) is not drawn.
8. The repair write is drawn going down the tree once; in reality one repair child is created per bad side or column.

## 12. Build order

See `../zfs-io-flow-diagram-spec.md` section 12 and `zfs-viewer-suite-spec.md`.

## 13. Acceptance checklist

- Counts: 61 nodes, 124 wires, 11 paths, 300 path steps, 11 groups, 9 wire types, 157 functions in the index, 278 wire references (Appendix C), 32 tunable and property references (Appendix D).
- Activating path `scrub_repair` with the default alternative highlights 26 distinct wires and plays 36 steps; `resilver` highlights 49 distinct wires and plays 58 steps; `scan_txg` highlights 18 distinct wires and plays 19 steps.
- Switching `scrub_repair` to `layout: raidz` swaps the mirror wires for the raidz wires and still plays as one connected piece.
- On this page, node `vdev_queue` shows "Also in: ZFS I/O Flow"; every node whose role starts with "Shared with the I/O flow graph." has the same id, title and context as in the I/O spec.
- Searching `zfs_scan_vdev_limit` finds `scan_exec_io`; searching `vdev_dtl_dirty` finds `dtl_dirty`.

## Appendix A. Function index

Functions named in section 8, with file and line at commit `c913da8615`.

```
zpool_do_scrub  cmd/zpool/zpool_main.c:8557
zpool_do_resilver  cmd/zpool/zpool_main.c:8721
scrub_callback  cmd/zpool/zpool_main.c:8488
zpool_do_attach_or_replace  cmd/zpool/zpool_main.c:7612
zpool_do_attach  cmd/zpool/zpool_main.c:7787
zpool_do_replace  cmd/zpool/zpool_main.c:7764
print_scan_scrub_resilver_status  cmd/zpool/zpool_main.c:9153
print_rebuild_status  cmd/zpool/zpool_main.c:9415
zpool_scan_range  lib/libzfs/libzfs_pool.c:3049
zpool_vdev_attach  lib/libzfs/libzfs_pool.c:3920
lzc_scrub  lib/libzfs_core/libzfs_core.c:289
zfs_ioc_pool_scrub  module/zfs/zfs_ioctl.c:2039
zfs_ioc_vdev_attach  module/zfs/zfs_ioctl.c:2391
spa_scan_range  module/zfs/spa.c:10127
spa_scan  module/zfs/spa.c:10121
spa_scan_stop  module/zfs/spa.c:10111
spa_scrub_pause_resume  module/zfs/spa.c:10100
spa_vdev_attach  module/zfs/spa.c:8545
spa_async_thread  module/zfs/spa.c:10239
spa_async_request  module/zfs/spa.c:10506
spa_vdev_resilver_done  module/zfs/spa.c:9999
spa_vdev_resilver_done_hunt  module/zfs/spa.c:9921
spa_vdev_detach  module/zfs/spa.c:8962
spa_sync  module/zfs/spa.c:11405
spa_sync_iterate_to_convergence  module/zfs/spa.c:11192
dsl_scan  module/zfs/dsl_scan.c:1088
dsl_scan_cancel  module/zfs/dsl_scan.c:1473
dsl_scrub_set_pause_resume  module/zfs/dsl_scan.c:1544
dsl_scan_restart_resilver  module/zfs/dsl_scan.c:1560
dsl_scan_assess_vdev  module/zfs/dsl_scan.c:5493
dsl_scan_setup_check  module/zfs/dsl_scan.c:949
dsl_scan_setup_sync  module/zfs/dsl_scan.c:963
dsl_errorscrub_setup_check  module/zfs/dsl_scan.c:864
dsl_errorscrub_setup_sync  module/zfs/dsl_scan.c:830
dsl_scrub_pause_resume_check  module/zfs/dsl_scan.c:1485
dsl_scrub_pause_resume_sync  module/zfs/dsl_scan.c:1507
dsl_scan_cancel_check  module/zfs/dsl_scan.c:1451
dsl_scan_cancel_sync  module/zfs/dsl_scan.c:1462
dsl_scan_sync_state  module/zfs/dsl_scan.c:902
dsl_errorscrub_sync_state  module/zfs/dsl_scan.c:818
dsl_scan_init  module/zfs/dsl_scan.c:564
dsl_scan_done  module/zfs/dsl_scan.c:1199
dsl_scan_sync  module/zfs/dsl_scan.c:4514
dsl_scan_active  module/zfs/dsl_scan.c:3866
dsl_scan_should_clear  module/zfs/dsl_scan.c:1702
dsl_scan_check_suspend  module/zfs/dsl_scan.c:1755
scan_io_queue_check_suspend  module/zfs/dsl_scan.c:3369
dsl_scan_visit  module/zfs/dsl_scan.c:3242
dsl_scan_visitds  module/zfs/dsl_scan.c:2915
dsl_scan_visit_rootbp  module/zfs/dsl_scan.c:2568
scan_ds_queue_insert  module/zfs/dsl_scan.c:1620
dsl_scan_ddt  module/zfs/dsl_scan.c:3182
dsl_scan_ddt_entry  module/zfs/dsl_scan.c:3110
dsl_scan_visitbp  module/zfs/dsl_scan.c:2488
dsl_scan_recurse  module/zfs/dsl_scan.c:2335
dsl_scan_visitdnode  module/zfs/dsl_scan.c:2459
dsl_scan_check_resume  module/zfs/dsl_scan.c:2289
dsl_scan_prefetch_thread  module/zfs/dsl_scan.c:2217
dsl_scan_prefetch  module/zfs/dsl_scan.c:2064
dsl_scan_prefetch_dnode  module/zfs/dsl_scan.c:2118
dsl_scan_prefetch_cb  module/zfs/dsl_scan.c:2148
dsl_scan_scrub_cb  module/zfs/dsl_scan.c:5003
count_block_skipped  module/zfs/dsl_scan.c:4861
dsl_scan_need_resilver  module/zfs/dsl_scan.c:3922
dsl_scan_check_deferred  module/zfs/dsl_scan.c:3902
dsl_scan_enqueue  module/zfs/dsl_scan.c:4968
scan_io_queue_insert  module/zfs/dsl_scan.c:4944
scan_io_queue_insert_impl  module/zfs/dsl_scan.c:4917
scan_io_queue_create  module/zfs/dsl_scan.c:5302
ext_size_compare  module/zfs/dsl_scan.c:5210
dsl_scan_freed  module/zfs/dsl_scan.c:5471
dsl_scan_freed_dva  module/zfs/dsl_scan.c:5392
scan_io_queues_run  module/zfs/dsl_scan.c:3667
scan_io_queues_run_one  module/zfs/dsl_scan.c:3569
scan_io_queue_fetch_ext  module/zfs/dsl_scan.c:3510
scan_io_queue_gather  module/zfs/dsl_scan.c:3429
scan_io_queue_issue  module/zfs/dsl_scan.c:3397
scan_exec_io  module/zfs/dsl_scan.c:5130
dsl_scan_scrub_done  module/zfs/dsl_scan.c:5073
count_block_issued  module/zfs/dsl_scan.c:4840
dsl_errorscrub_sync  module/zfs/dsl_scan.c:4351
scrub_filesystem  module/zfs/dsl_scan.c:4219
dsl_error_scrub_check_suspend  module/zfs/dsl_scan.c:1835
dsl_errorscrub_done  module/zfs/dsl_scan.c:1172
read_by_block_level  module/zfs/dsl_scan.c:4138
spa_scan_get_stats  module/zfs/spa_misc.c:3095
txg_sync_thread  module/zfs/txg.c:510
txg_wait_synced  module/zfs/txg.c:764
vdev_open  module/zfs/vdev.c:2216
vdev_dtl_dirty  module/zfs/vdev.c:3229
vdev_dtl_contains  module/zfs/vdev.c:3247
vdev_dtl_empty  module/zfs/vdev.c:3272
vdev_resilver_needed  module/zfs/vdev.c:3911
vdev_dtl_need_resilver  module/zfs/vdev.c:3305
vdev_default_need_resilver  module/zfs/vdev.c:3289
vdev_dtl_required  module/zfs/vdev.c:3875
vdev_defer_resilver  module/zfs/vdev.c:6117
vdev_clear_resilver_deferred  module/zfs/vdev.c:6131
vdev_dtl_reassess  module/zfs/vdev.c:3630
vdev_dtl_reassess_impl  module/zfs/vdev.c:3417
vdev_dtl_should_excise  module/zfs/vdev.c:3353
vdev_dtl_sync  module/zfs/vdev.c:3791
vdev_dirty  module/zfs/vdev.c:3163
vdev_sync  module/zfs/vdev.c:4409
vdev_stat_update  module/zfs/vdev.c:5348
vdev_scan_stat_init  module/zfs/vdev.c:5335
vdev_raidz_need_resilver  module/zfs/vdev_raidz.c:4224
vdev_raidz_io_start  module/zfs/vdev_raidz.c:2814
vdev_raidz_io_start_read_row  module/zfs/vdev_raidz.c:2663
vdev_raidz_io_done  module/zfs/vdev_raidz.c:4044
raidz_checksum_verify  module/zfs/vdev_raidz.c:2956
raidz_parity_verify  module/zfs/vdev_raidz.c:2989
vdev_raidz_combrec  module/zfs/vdev_raidz.c:3717
vdev_raidz_io_done_verified  module/zfs/vdev_raidz.c:3291
vdev_draid_io_start  module/zfs/vdev_draid.c:2257
vdev_draid_io_start_read  module/zfs/vdev_draid.c:2081
vdev_rebuild  module/zfs/vdev_rebuild.c:1033
vdev_rebuild_initiate  module/zfs/vdev_rebuild.c:271
vdev_rebuild_initiate_sync  module/zfs/vdev_rebuild.c:211
vdev_rebuild_thread  module/zfs/vdev_rebuild.c:754
vdev_rebuild_ranges  module/zfs/vdev_rebuild.c:631
vdev_rebuild_range  module/zfs/vdev_rebuild.c:548
vdev_rebuild_blkptr_init  module/zfs/vdev_rebuild.c:512
vdev_rebuild_cb  module/zfs/vdev_rebuild.c:476
vdev_rebuild_complete_sync  module/zfs/vdev_rebuild.c:294
arc_read  module/zfs/arc.c:5905
zio_read  module/zfs/zio.c:1345
zio_root  module/zfs/zio.c:1093
zio_nowait  module/zfs/zio.c:2890
zio_wait  module/zfs/zio.c:2841
zio_read_bp_init  module/zfs/zio.c:1865
zio_ready  module/zfs/zio.c:5909
zio_vdev_io_start  module/zfs/zio.c:5135
zio_vdev_io_bypass  module/zfs/zio.c:5545
zio_vdev_child_io  module/zfs/zio.c:1627
zio_taskq_dispatch  module/zfs/zio.c:2258
zio_interrupt  module/zfs/zio.c:2496
zio_vdev_io_done  module/zfs/zio.c:5320
zio_vdev_io_assess  module/zfs/zio.c:5436
zio_checksum_verify  module/zfs/zio.c:5747
zio_done  module/zfs/zio.c:6065
zio_free_sync  module/zfs/zio.c:1477
zio_dva_free  module/zfs/zio.c:4955
zio_checksum_error  module/zfs/zio_checksum.c:554
vdev_mirror_io_start  module/zfs/vdev_mirror.c:699
vdev_mirror_map_init  module/zfs/vdev_mirror.c:232
vdev_mirror_io_start_impl  module/zfs/vdev_mirror.c:612
vdev_mirror_child_select  module/zfs/vdev_mirror.c:524
vdev_mirror_io_done  module/zfs/vdev_mirror.c:734
vdev_queue_io  module/zfs/vdev_queue.c:904
vdev_queue_io_to_issue  module/zfs/vdev_queue.c:801
vdev_queue_class_max_active  module/zfs/vdev_queue.c:346
vdev_queue_io_done  module/zfs/vdev_queue.c:983
vdev_disk_io_start  module/os/linux/zfs/vdev_disk.c:1241
vbio_completion  module/os/linux/zfs/vdev_disk.c:881
vdev_geom_io_start  module/os/freebsd/zfs/vdev_geom.c:1126
vdev_geom_io_intr  module/os/freebsd/zfs/vdev_geom.c:1002
```

## Appendix C. Wire source references

274 references for the 122 wires, at commit `c913da8615`. Each line is `<wire>  <file>:<line>  <symbol>`, and the symbol appears verbatim on that source line. A wire's references are listed in the order of the calls in its label. Where a wire is a callback or a pipeline decision, the reference is the line where the callback is invoked or the decision is made.

```
E001  cmd/zpool/zpool_main.c:8704  scrub_callback
E001  cmd/zpool/zpool_main.c:8502  zpool_scan_range
E002  lib/libzfs/libzfs_pool.c:3068  lzc_scrub
E002  module/zfs/zfs_ioctl.c:8193  ZFS_IOC_POOL_SCRUB
E003  module/zfs/zfs_ioctl.c:2067  spa_scrub_pause_resume
E003  module/zfs/zfs_ioctl.c:2069  spa_scan_stop
E003  module/zfs/zfs_ioctl.c:2076  spa_get_last_scrubbed_txg
E003  module/zfs/zfs_ioctl.c:2083  dbrrd_query
E003  module/zfs/zfs_ioctl.c:2094  spa_scan_range
E004  module/zfs/spa.c:10161  dsl_scan(
E004  module/zfs/spa.c:10107  dsl_scrub_set_pause_resume
E004  module/zfs/spa.c:10117  dsl_scan_cancel
E005  module/zfs/dsl_scan.c:1108  vdev_reopen
E005  module/zfs/vdev.c:2485  spa_scrub_reopen
E006  module/zfs/dsl_scan.c:1166  dsl_sync_task
E006  module/zfs/dsl_synctask.c:80  txg_wait_synced
E007  module/zfs/txg.c:533  dsl_scan_active
E007  module/zfs/txg.c:602  spa_sync(spa,
E008  module/zfs/spa.c:11208  dsl_pool_sync
E008  module/zfs/dsl_pool.c:876  dsl_sync_task_sync
E008  module/zfs/dsl_scan.c:955  vdev_rebuild_active
E008  module/zfs/dsl_scan.c:1136  dsl_errorscrub_setup_sync
E009  module/zfs/dsl_scan.c:1010  vdev_resilver_needed
E009  module/zfs/dsl_scan.c:1016  ESC_ZFS_RESILVER_START
E010  module/zfs/dsl_scan.c:985  DSS_SCANNING
E010  module/zfs/dsl_scan.c:995  vs_alloc
E010  module/zfs/dsl_scan.c:1067  zap_create
E010  module/zfs/dsl_scan.c:1074  SYNC_MANDATORY
E011  module/zfs/spa.c:11231  dsl_scan_sync
E011  module/zfs/dsl_scan.c:4547  spa_sync_pass
E012  module/zfs/dsl_scan.c:4748  zio_root
E012  module/zfs/dsl_scan.c:4757  dsl_scan_visit(
E013  module/zfs/dsl_scan.c:4753  dsl_scan_prefetch_thread
E013  module/zfs/dsl_scan.c:4761  scn_prefetch_stop
E014  module/zfs/dsl_scan.c:3251  dsl_scan_ddt
E015  module/zfs/dsl_scan.c:3141  ddt_bp_create
E015  module/zfs/dsl_scan.c:3144  scan_funcs
E016  module/zfs/dsl_scan.c:3261  dsl_scan_visit_rootbp
E016  module/zfs/dsl_scan.c:3311  scn_cur_min_txg
E016  module/zfs/dsl_scan.c:2590  dsl_scan_visitbp
E017  module/zfs/dsl_scan.c:2587  dsl_scan_prefetch(
E018  module/zfs/dsl_scan.c:2494  dsl_scan_check_suspend
E018  module/zfs/dsl_scan.c:1792  zfs_resilver_min_time_ms
E018  module/zfs/dsl_scan.c:1796  txg_sync_waiting
E018  module/zfs/dsl_scan.c:1797  zfs_txg_timeout
E019  module/zfs/dsl_scan.c:1816  scn_bookmark
E019  module/zfs/dsl_scan.c:2301  zbookmark_subtree_completed
E020  module/zfs/dsl_scan.c:2366  arc_read
E020  module/zfs/dsl_scan.c:2341  ZIO_FLAG_SCAN_THREAD
E021  module/zfs/dsl_scan.c:2378  dsl_scan_visitbp
E021  module/zfs/dsl_scan.c:2403  dsl_scan_visitdnode
E022  module/zfs/dsl_scan.c:2268  arc_read
E022  module/zfs/dsl_scan.c:2237  scn_maxinflight_bytes
E023  module/zfs/dsl_scan.c:2176  dsl_scan_prefetch(
E023  module/zfs/dsl_scan.c:2076  DMU_OT_DNODE
E024  module/zfs/dsl_scan.c:2533  scn_cur_min_txg
E024  module/zfs/dsl_scan.c:2546  ddt_class_contains
E024  module/zfs/dsl_scan.c:2564  scan_funcs
E025  module/zfs/dsl_scan.c:5058  dsl_scan_need_resilver
E026  module/zfs/dsl_scan.c:3958  vdev_dtl_need_resilver
E026  module/zfs/vdev.c:3298  DTL_PARTIAL
E026  module/zfs/vdev_raidz.c:4249  vdev_dtl_contains
E027  module/zfs/dsl_scan.c:3965  dsl_scan_check_deferred
E027  module/zfs/dsl_scan.c:3915  vdev_resilver_deferred
E028  module/zfs/dsl_scan.c:5062  needs_io
E028  module/zfs/dsl_scan.c:5065  count_block_skipped
E029  module/zfs/dsl_scan.c:5063  dsl_scan_enqueue
E029  module/zfs/dsl_scan.c:5033  ZIO_FLAG_SCRUB
E029  module/zfs/dsl_scan.c:5037  ZIO_FLAG_RESILVER
E029  module/zfs/dsl_scan.c:5015  ZIO_FLAG_RAW
E030  module/zfs/dsl_scan.c:4996  scan_io_queue_insert
E030  module/zfs/dsl_scan.c:4931  avl_insert
E030  module/zfs/dsl_scan.c:4933  zfs_range_tree_add
E031  module/zfs/dsl_scan.c:4979  BP_IS_GANG
E031  module/zfs/dsl_scan.c:4980  scan_exec_io
E032  module/zfs/dsl_scan.c:4836  dsl_scan_sync_state
E032  module/zfs/dsl_scan.c:908  scn_queues_pending
E033  module/zfs/dsl_scan.c:4696  dsl_scan_should_clear
E033  module/zfs/dsl_scan.c:1712  zfs_scan_mem_lim_fact
E033  module/zfs/dsl_scan.c:1714  MIN(mlim_hard,
E033  module/zfs/dsl_scan.c:4688  zfs_scan_checkpoint_intval
E034  module/zfs/dsl_scan.c:4807  scan_io_queues_run
E035  module/zfs/dsl_scan.c:3697  scan_io_queues_run_one
E035  module/zfs/dsl_scan.c:3599  scan_io_queue_fetch_ext
E035  module/zfs/dsl_scan.c:3530  zfs_scan_issue_strategy
E035  module/zfs/dsl_scan.c:3613  scan_io_queue_gather
E036  module/zfs/dsl_scan.c:3406  scan_io_queue_check_suspend
E037  module/zfs/dsl_scan.c:3649  scan_io_queue_insert_impl
E038  module/zfs/dsl_scan.c:3411  sio2bp
E038  module/zfs/dsl_scan.c:3412  scan_exec_io
E039  module/zfs/dsl_scan.c:5154  q_maxinflight_bytes
E039  module/zfs/dsl_scan.c:5165  zio_read
E040  module/zfs/dsl_scan.c:5165  dsl_scan_scrub_done
E040  module/zfs/dsl_scan.c:5088  q_inflight_bytes
E040  module/zfs/dsl_scan.c:5117  scn_errors
E041  module/zfs/zio.c:4961  dsl_scan_freed
E041  module/zfs/zio.c:1505  dsl_scan_freed
E041  module/zfs/dsl_scan.c:5446  avl_remove
E042  module/zfs/vdev_label.c:422  spa_scan_get_stats
E042  module/zfs/vdev_label.c:424  ZPOOL_CONFIG_SCAN_STATS
E042  cmd/zpool/zpool_main.c:9309  secs_to_dhms
E043  module/zfs/zio.c:1355  ZIO_READ_PIPELINE
E043  module/zfs/zio.c:1875  ZIO_FLAG_RAW_COMPRESS
E044  module/zfs/zio.c:5909  zio_ready
E045  module/zfs/zio.c:5135  zio_vdev_io_start
E046  module/zfs/zio.c:5175  vdev_op_io_start
E046  module/zfs/vdev_mirror.c:270  scn_is_sorted
E047  module/zfs/vdev_mirror.c:691  zio_vdev_child_io
E048  module/zfs/zio.c:1631  ZIO_VDEV_CHILD_PIPELINE
E048  module/zfs/zio.c:1651  ZIO_STAGE_CHECKSUM_VERIFY
E049  module/zfs/zio.c:5315  vdev_op_io_start
E050  module/zfs/zio.c:5315  vdev_op_io_start
E051  module/zfs/vdev_mirror.c:618  ZIO_FLAG_SCRUB
E051  module/zfs/vdev_mirror.c:645  zio_vdev_child_io
E052  module/zfs/vdev_mirror.c:551  vdev_mirror_child_missing
E052  module/zfs/vdev_mirror.c:488  vdev_dtl_contains
E052  module/zfs/vdev_mirror.c:510  vdev_dtl_empty
E053  module/zfs/vdev_mirror.c:658  vdev_mirror_child_select
E053  module/zfs/vdev_mirror.c:691  zio_vdev_child_io
E054  module/zfs/vdev_raidz.c:2686  vdev_dtl_contains
E054  module/zfs/vdev_draid.c:2109  vdev_draid_missing
E055  module/zfs/vdev_raidz.c:2736  ZIO_FLAG_SCRUB
E055  module/zfs/vdev_raidz.c:2737  zio_vdev_child_io
E055  module/zfs/vdev_draid.c:2244  ZIO_FLAG_SCRUB
E056  module/zfs/zio.c:5289  vdev_queue_io
E056  module/zfs/vdev_queue.c:922  ZIO_PRIORITY_SCRUB
E057  module/zfs/vdev_queue.c:1009  vdev_queue_io_to_issue
E057  module/zfs/vdev_queue.c:358  vq_ia_active
E057  module/zfs/vdev_queue.c:363  zfs_vdev_scrub_max_active
E058  module/os/linux/zfs/vdev_disk.c:671  submit_bio
E058  module/os/freebsd/zfs/vdev_geom.c:1226  g_io_request
E059  module/os/linux/zfs/vdev_disk.c:881  vbio_completion
E059  module/os/freebsd/zfs/vdev_geom.c:1002  vdev_geom_io_intr
E060  module/os/linux/zfs/vdev_disk.c:910  zio_delay_interrupt
E060  module/zfs/zio.c:2536  zio_interrupt
E061  module/zfs/zio.c:2500  ZIO_TASKQ_INTERRUPT
E062  module/zfs/zio.c:5345  vdev_queue_io_done
E063  module/zfs/zio.c:5320  zio_vdev_io_done
E063  module/zfs/zio.c:5436  zio_vdev_io_assess
E064  module/zfs/zio.c:5747  zio_checksum_verify
E065  module/zfs/zio.c:5768  zio_checksum_error
E065  module/zfs/zio.c:5792  vs_checksum_errors++
E065  module/zfs/zio.c:5794  zfs_ereport_start_checksum
E066  module/zfs/zio.c:6362  zio_notify_parent
E067  module/zfs/vdev_mirror.c:814  vdev_mirror_child_select
E067  module/zfs/vdev_mirror.c:890  abd_copy
E067  module/zfs/vdev_mirror.c:906  ZIO_FLAG_RESILVER
E067  module/zfs/vdev_mirror.c:942  DTL_PARTIAL
E068  module/zfs/vdev_mirror.c:953  ZIO_FLAG_IO_REPAIR
E068  module/zfs/vdev_mirror.c:952  ZIO_PRIORITY_ASYNC_WRITE
E069  module/zfs/vdev_raidz.c:4097  vdev_raidz_io_done_reconstruct_known_missing
E069  module/zfs/vdev_raidz.c:4101  raidz_checksum_verify
E069  module/zfs/vdev_raidz.c:4133  vdev_raidz_read_all
E069  module/zfs/vdev_raidz.c:4195  vdev_raidz_combrec
E069  module/zfs/vdev_raidz.c:3351  raidz_parity_verify
E070  module/zfs/vdev_raidz.c:3365  ZIO_FLAG_RESILVER
E070  module/zfs/vdev_raidz.c:3400  zio_vdev_child_io
E070  module/zfs/vdev_raidz.c:3405  ZIO_FLAG_IO_REPAIR
E071  module/zfs/zio.c:5268  ZIO_FLAG_SELF_HEAL)
E071  module/zfs/zio.c:5272  vdev_dtl_contains
E071  module/zfs/zio.c:5274  zio_vdev_io_bypass
E072  module/zfs/zio.c:6180  vdev_stat_update
E073  module/zfs/vdev.c:5396  ZIO_FLAG_SCAN_THREAD
E073  module/zfs/vdev.c:5399  scn_processed
E074  module/zfs/vdev.c:5502  EIO
E074  module/zfs/vdev.c:5565  DTL_MISSING,
E074  module/zfs/vdev.c:5561  DTL_PARTIAL
E074  module/zfs/vdev.c:5562  VDD_DTL
E074  module/zfs/vdev.c:5547  DTL_SCRUB
E075  module/zfs/vdev.c:3175  vdev_dtl_list
E076  module/zfs/spa.c:11241  vdev_sync
E076  module/zfs/vdev.c:4453  vdev_dtl_sync
E076  module/zfs/vdev.c:3846  space_map_write
E077  module/zfs/zio.c:5292  vdev_accessible
E077  module/zfs/zio.c:5294  zio_interrupt
E078  module/zfs/zio.c:5494  vdev_accessible
E078  module/zfs/zio.c:5522  ZIO_INTERLOCK_PIPELINE
E079  module/zfs/vdev_mirror.c:667  mm_children;
E079  module/zfs/vdev_mirror.c:691  zio_vdev_child_io
E080  module/zfs/vdev_mirror.c:758  ZIO_TYPE_WRITE
E080  module/zfs/vdev_mirror.c:783  vdev_mirror_worst_error
E081  module/zfs/vdev.c:2486  dsl_scan_assess_vdev
E081  module/zfs/dsl_scan.c:5497  vdev_resilver_needed
E082  module/zfs/dsl_scan.c:5501  spa_async_request
E082  module/zfs/dsl_scan.c:5512  spa_async_request
E083  module/zfs/dsl_scan.c:5505  scn_max_txg
E083  module/zfs/dsl_scan.c:5510  vdev_defer_resilver
E084  module/zfs/spa.c:10339  vdev_rebuild_active
E084  module/zfs/spa.c:10342  dsl_scan_restart_resilver
E085  module/zfs/dsl_scan.c:1568  scn_restart_txg
E086  module/zfs/dsl_scan.c:4559  restart_early)
E086  module/zfs/dsl_scan.c:4565  dsl_scan_done
E086  module/zfs/dsl_scan.c:4567  POOL_SCAN_RESILVER;
E086  module/zfs/dsl_scan.c:4571  dsl_scan_setup_sync
E087  module/zfs/spa.c:8895  vdev_dtl_dirty
E088  module/zfs/spa.c:8920  vdev_resilver_txg
E088  module/zfs/spa.c:8927  dsl_scan_restart_resilver
E089  module/zfs/spa.c:8925  vdev_defer_resilver(newvd)
E090  module/zfs/spa.c:8916  vdev_rebuild_txg
E090  module/zfs/spa.c:8918  vdev_rebuild(tvd,
E091  cmd/zpool/zpool_main.c:7645  rebuild
E091  cmd/zpool/zpool_main.c:7731  zpool_vdev_attach
E092  lib/libzfs/libzfs_pool.c:3956  zc_simple
E092  lib/libzfs/libzfs_pool.c:4021  ZFS_IOC_VDEV_ATTACH
E092  module/zfs/zfs_ioctl.c:2404  spa_vdev_attach
E093  module/zfs/dsl_scan.c:4522  spa_resilver_deferred
E093  module/zfs/dsl_scan.c:4527  spa_feature_incr
E093  module/zfs/dsl_scan.c:4540  zfs_resilver_disable_defer
E093  module/zfs/dsl_scan.c:4541  zfs_resilver_defer_percent
E094  module/zfs/dsl_scan.c:1338  vdev_clear_resilver_deferred
E094  module/zfs/vdev.c:6143  spa_feature_decr
E095  module/zfs/dsl_scan.c:1325  SPA_ASYNC_RESILVER_DONE
E095  module/zfs/dsl_scan.c:1342  SPA_ASYNC_RESILVER)
E096  module/zfs/vdev.c:3360  vdev_resilver_deferred
E097  module/zfs/dsl_scan.c:4832  dsl_scan_done
E097  module/zfs/dsl_scan.c:4833  SYNC_MANDATORY;
E098  module/zfs/dsl_scan.c:3327  ZB_DESTROYED_OBJSET;
E098  module/zfs/dsl_scan.c:4789  scn_done_txg
E099  module/zfs/dsl_scan.c:1286  vdev_dtl_reassess
E099  module/zfs/dsl_scan.c:1301  vdev_dtl_reassess
E100  module/zfs/vdev.c:3501  space_reftree_add_seg
E100  module/zfs/vdev.c:3560  VDD_DTL
E101  module/zfs/dsl_scan.c:1310  DSS_FINISHED
E101  module/zfs/dsl_scan.c:1264  DMU_POOL_LAST_SCRUBBED_TXG
E101  module/zfs/dsl_scan.c:1304  spa_errlog_rotate
E102  module/zfs/spa.c:10332  spa_vdev_resilver_done
E103  module/zfs/spa.c:9945  vdev_dtl_empty(newvd,
E103  module/zfs/spa.c:9947  vdev_dtl_required
E103  module/zfs/spa.c:10026  spa_vdev_detach
E104  module/zfs/vdev_rebuild.c:239  vdev_resilver_needed
E105  module/zfs/vdev_rebuild.c:283  vdev_rebuild_initiate_sync
E105  module/zfs/vdev_rebuild.c:250  thread_create
E105  module/zfs/vdev_rebuild.c:1055  vdev_rebuild_reset_wanted
E106  module/zfs/vdev_rebuild.c:768  dsl_scan_cancel
E107  module/zfs/vdev_rebuild.c:837  metaslab_disable
E107  module/zfs/vdev_rebuild.c:878  space_map_load
E107  module/zfs/vdev_rebuild.c:917  vdev_rebuild_ranges
E107  module/zfs/vdev_rebuild.c:662  zfs_rebuild_max_segment
E108  module/zfs/vdev_rebuild.c:570  vdev_dtl_need_resilver
E108  module/zfs/vdev.c:3295  TXG_UNKNOWN
E109  module/zfs/vdev_rebuild.c:616  zio_read
E109  module/zfs/vdev_rebuild.c:567  vdev_rebuild_blkptr_init
E109  module/zfs/vdev_rebuild.c:535  ZIO_CHECKSUM_OFF
E109  module/zfs/vdev_rebuild.c:578  vr_bytes_inflight_max
E109  module/zfs/vdev_rebuild.c:818  zfs_rebuild_vdev_limit
E110  module/zfs/vdev_rebuild.c:617  vdev_rebuild_cb
E110  module/zfs/vdev_rebuild.c:494  vrp_errors++
E111  module/zfs/vdev_rebuild.c:963  vdev_rebuild_complete_sync
E112  module/zfs/vdev_rebuild.c:321  vdev_dtl_reassess
E112  module/zfs/vdev.c:3470  vrp_errors
E113  module/zfs/vdev_rebuild.c:330  SPA_ASYNC_REBUILD_DONE
E114  module/zfs/vdev_rebuild.c:343  dsl_scan_setup_check
E114  module/zfs/vdev_rebuild.c:344  zfs_rebuild_scrub_enabled
E114  module/zfs/vdev_rebuild.c:345  dsl_scan_setup_sync
E115  module/zfs/dsl_pool.c:876  dsl_sync_task_sync
E115  module/zfs/dsl_scan.c:1517  DSF_SCRUB_PAUSED
E115  module/zfs/dsl_scan.c:1467  dsl_scan_done
E115  module/zfs/dsl_scan.c:1498  EBUSY
E116  module/zfs/dsl_scan.c:1519  SYNC_CACHED
E116  module/zfs/dsl_scan.c:1468  SYNC_MANDATORY
E117  module/zfs/dsl_scan.c:1467  dsl_scan_done
E117  module/zfs/dsl_scan.c:1243  scan_io_queues_destroy
E118  module/zfs/dsl_scan.c:4624  dsl_scan_is_paused_scrub
E118  module/zfs/dsl_scan.c:3876  dsl_scan_is_paused_scrub
E119  module/zfs/spa.c:11232  dsl_errorscrub_sync
E119  module/zfs/dsl_scan.c:4377  dsl_scan_cancel
E120  module/zfs/dsl_scan.c:4480  scrub_filesystem
E120  module/zfs/dsl_scan.c:4249  read_by_block_level
E120  module/zfs/dsl_scan.c:4427  zfs_scrub_error_blocks_per_txg
E121  module/zfs/dsl_scan.c:4175  dbuf_dnode_findbp
E121  module/zfs/dsl_scan.c:4207  scan_exec_io
E122  module/zfs/dsl_scan.c:4437  dsl_errorscrub_sync_state
E122  module/zfs/dsl_scan.c:4435  dsl_errorscrub_done
E122  module/zfs/dsl_scan.c:1188  spa_errlog_rotate
E123  cmd/zpool/zpool_main.c:402  zpool_do_scrub
E123  cmd/zpool/zpool_main.c:401  zpool_do_resilver
E124  cmd/zpool/zpool_main.c:395  zpool_do_attach
E124  cmd/zpool/zpool_main.c:397  zpool_do_replace
```

## Appendix D. Tunable and property source references

Where each tunable named in section 8 is declared, at commit `c913da8615`. A tunable's symbol is the name as written in its `ZFS_MODULE_PARAM` line (the macro joins it to the prefix given there). This graph names no dataset or pool properties.

```
zfs_txg_timeout  module/zfs/txg.c:1096  timeout
zfs_dirty_data_max  module/zfs/dsl_pool.c:1567  dirty_data_max
zfs_vdev_async_write_active_min_dirty_percent  module/zfs/vdev_queue.c:1133  async_write_active_min_dirty_percent
zfs_scan_legacy  module/zfs/dsl_scan.c:5560  scan_legacy
zfs_scan_checkpoint_intval  module/zfs/dsl_scan.c:5566  scan_checkpoint_intval
zfs_scan_mem_lim_fact  module/zfs/dsl_scan.c:5554  scan_mem_lim_fact
zfs_scan_mem_lim_soft_fact  module/zfs/dsl_scan.c:5572  scan_mem_lim_soft_fact
zfs_import_defer_txgs  module/zfs/dsl_scan.c:5563  import_defer_txgs
zfs_scrub_min_time_ms  module/zfs/dsl_scan.c:5518  scrub_min_time_ms
zfs_resilver_min_time_ms  module/zfs/dsl_scan.c:5527  resilver_min_time_ms
zfs_scan_strict_mem_lim  module/zfs/dsl_scan.c:5575  scan_strict_mem_lim
zfs_no_scrub_prefetch  module/zfs/dsl_scan.c:5536  no_scrub_prefetch
zfs_no_scrub_io  module/zfs/dsl_scan.c:5533  no_scrub_io
zfs_scan_max_ext_gap  module/zfs/dsl_scan.c:5569  scan_max_ext_gap
zfs_scan_fill_weight  module/zfs/dsl_scan.c:5578  scan_fill_weight
zfs_scan_issue_strategy  module/zfs/dsl_scan.c:5557  scan_issue_strategy
zfs_scan_vdev_limit  module/zfs/dsl_scan.c:5515  scan_vdev_limit
zfs_scrub_error_blocks_per_txg  module/zfs/dsl_scan.c:5590  scrub_error_blocks_per_txg
zfs_resilver_disable_defer  module/zfs/dsl_scan.c:5584  resilver_disable_defer
zfs_resilver_defer_percent  module/zfs/dsl_scan.c:5587  resilver_defer_percent
zfs_rebuild_vdev_limit  module/zfs/vdev_rebuild.c:1210  rebuild_vdev_limit
zfs_rebuild_max_segment  module/zfs/vdev_rebuild.c:1207  rebuild_max_segment
zfs_rebuild_scrub_enabled  module/zfs/vdev_rebuild.c:1213  rebuild_scrub_enabled
zfs_scan_ignore_errors  module/zfs/vdev.c:7397  scan_ignore_errors
zfs_vdev_dtl_sm_blksz  module/zfs/vdev.c:7374  dtl_sm_blksz
zfs_vdev_scrub_min_active  module/zfs/vdev_queue.c:1163  scrub_min_active
zfs_vdev_scrub_max_active  module/zfs/vdev_queue.c:1160  scrub_max_active
zfs_vdev_rebuild_min_active  module/zfs/vdev_queue.c:1187  rebuild_min_active
zfs_vdev_rebuild_max_active  module/zfs/vdev_queue.c:1184  rebuild_max_active
zfs_vdev_nia_delay  module/zfs/vdev_queue.c:1193  nia_delay
zfs_vdev_nia_credit  module/zfs/vdev_queue.c:1190  nia_credit
zfs_vdev_max_active  module/zfs/vdev_queue.c:1127  max_active
```
