# ZFS fault management (build spec)

This diagram follows a misbehaving disk from the failed or wrong I/O in the zio pipeline to everything ZFS does about it: the per-vdev error counters shown by zpool status, the ereports and other events in the kernel zevent queue, the ZFS event daemon (zed) that reads them and decides whether a disk is faulted or degraded, the hot spare that replaces it, the dirty time log that remembers what a missing disk did not get, the pool suspend that stops I/O when nothing else is possible, and the persistent error log behind "permanent errors" in zpool status -v.

Source of truth: `https://github.com/openzfs/zfs` at commit `c913da86156eba3243cc1ef515e98d69887654a7` (master, 2026-11-13, version 2.4.99). Every function name, file path and tunable in this document was checked against that commit.

## 0. Instructions to the building agent

Render this spec with the viewer in `../viewer`, as extended by `zfs-viewer-suite-spec.md`. The viewer behaviour is defined in sections 3 to 5 of `../zfs-io-flow-diagram-spec.md`. Treat sections 6 to 10 and the appendices as data; do not change content without verifying the change at the pinned commit.

## 1. Goal

One page that lets a ZFS administrator answer "when a disk misbehaves, what does ZFS record, who decides the disk is faulted, when does a hot spare kick in, what makes the pool suspend, and where do the zpool status error counts and 'permanent errors' come from?" by following wires between boxes.

### Mental model the diagram has to convey

1. Errors are detected inside the zio pipeline when an I/O completes (VDEV_IO_DONE, VDEV_IO_ASSESS, CHECKSUM_VERIFY, DONE). Each problem is recorded in up to three separate places: an in-memory counter on the vdev (the READ, WRITE, CKSUM and SLOW columns of zpool status), an event in the kernel zevent queue, and, only when a logical read or write failed after all redundancy, an entry in the persistent error log.
2. The records are filtered. A disk that is already dead gets no counts and no ereports; an io or checksum ereport identical to one posted for the same disk within zfs_zevent_retain_expire_secs is a duplicate and dropped, and a duplicate io ereport does not raise the READ or WRITE counter either; checksum, delay and deadman ereports are rate limited per disk. The counters live only in memory and are reset by zpool clear.
3. The kernel does not fault a disk because of its error counts. zed reads the zevent queue through /dev/zfs; its diagnosis engine counts io and checksum ereports per disk in SERD engines (10 events in 600 seconds by default, tunable per vdev), and its retire agent then asks the kernel through libzfs to fault the disk (I/O errors) or degrade it (checksum errors, slow I/O) and to attach a hot spare. Without zed, a disk that keeps returning errors but still answers the kernel's probes stays ONLINE.
4. The kernel changes a disk's state on its own only when it cannot reach it: a failed probe of the label areas makes it FAULTED, a disk the operating system reports gone becomes REMOVED. If a disk to be faulted this way holds the only copy of some data, it is left DEGRADED and the pool suspends instead.
5. While a disk is missing, writes to it fail at once with ENXIO and their txgs are added to its dirty time log (DTL). When the disk comes back, or a spare or replacement is attached, a resilver copies exactly those txgs.
6. The pool suspends when I/O fails that must not be dropped: label writes in spa_sync(), a read of data whose every copy is on missing disks, or the only copy of some data being faulted. The failmode property decides what callers see meanwhile (wait, continue with EIO, or panic); zpool clear clears the errors, reopens the devices and re-executes every held I/O.
7. A permanent error is the bookmark of a logical block that could not be read or written. It is kept in memory, written to the pool's error log in the next txg, and listed by zpool status -v with file names resolved at that moment. zpool clear does not remove it; it disappears only when a scrub or resilver ends without having seen the error again (the code rotates the log at the end of every scan, completed or cancelled).

### Scope

In scope: error detection in the zio pipeline (I/O errors, checksum errors, slow I/O, hung I/O), per-vdev error counters, ereport construction, duplicate suppression and rate limiting, the zevent queue and its /dev/zfs readers, the zed event loop, zedlets, the diagnosis, retire and hotplug (zfs_mod) agents, vdev fault, degrade, remove and online, hot spares and autoreplace, DTL recording while a disk is missing, the resilver trigger, pool suspend and resume, failmode, the persistent error log and zpool status / zpool events / zpool clear.

Out of scope: how a scrub or resilver walks the pool (the scrub and resilver graph), MMP (multihost) suspends, Direct I/O checksum verify errors, encryption authentication errors, RAIDZ sit-out of slow disks, L2ARC and log device error handling, illumos fmd and FreeBSD zfsd.

## 2. Deliverable

Built by `../viewer/build_graph.py --spec specs/zfs-fault-management-spec.md`; the page is `zfs-fault-management.html` in the suite defined by `zfs-viewer-suite-spec.md`.

## 6. Wire types and contexts

### 6.1 Wire types

| type id | colour | name | what travels on the wire |
|---|---|---|---|
| `abd` | `#FF6B6B` | Physical payload | Data read from a disk, on its way to checksum verification. |
| `zio` | `#4DABF7` | I/O request | zio_t moving through the pipeline, being retried, re-executed or completed. |
| `tx` | `#FFD43B` | Transaction | dmu_tx_t assignment, or work done for one txg in syncing context. |
| `bio` | `#E9ECEF` | Device I/O | The block-device request and its completion status. |
| `ctl` | `#868E96` | Control | Calls and requests: counters, state changes, ioctls, status queries. Draw dashed. |
| `dtl` | `#63E6BE` | Dirty time log | Txg ranges a device is missing (DTL_MISSING / DTL_PARTIAL), in memory or as a space map. |
| `event` | `#F76707` | Events | Ereports, resource and sysevent nvlists in the zevent queue, zed agent events and fault lists. |

### 6.2 Execution contexts

| ctx id | meaning |
|---|---|
| `user` | Userspace: zpool and libzfs (also when called from zed) |
| `open` | Open context: the calling thread, inside a dmu_tx |
| `sync` | Syncing context: txg_sync thread, one txg at a time |
| `iss` | zio issue taskq |
| `int` | zio interrupt taskq: completion processing |
| `thr` | A dedicated kernel thread or delayed task (SPA async thread, deadman) |
| `any` | Runs in whichever context calls it |
| `hw` | Hardware |
| `zed` | The userspace ZFS event daemon (zed) and its agent thread |
| `syscall` | Kernel, in the thread of the calling process (an ioctl on /dev/zfs, mount(2) or umount(2)) or a helper thread it starts, outside syncing context and outside any dmu_tx |

## 7. Groups and default layout

Flow runs left to right: the failing disk and the zio pipeline on the left, then what the kernel records, the events, zed, the userspace tools, the kernel state changes they request, and syncing context on the right.

| group id | title | colour | first column | band | sub-columns | nodes | summary |
|---|---|---|---|---|---|---|---|
| `pipe` | I/O pipeline (shared with the I/O graph) | `#1971C2` | 0 | full | 2 | 12 | Where a failed, wrong or slow I/O is noticed. |
| `record` | Kernel records: counters, DTL, error log, suspend | `#C2255C` | 2 | full | 1 | 6 | What the kernel remembers about errors, and its own last-resort reactions. |
| `fm` | Ereports and the zevent queue | `#D9480F` | 3 | full | 1 | 6 | Events built in the kernel and queued for userspace readers. |
| `zed` | ZFS event daemon (zed) | `#2B8A3E` | 4 | full | 2 | 9 | Reads every event, runs zedlets and decides about faults and spares. |
| `user` | libzfs and the zpool command | `#5C5F66` | 6 | full | 1 | 6 | The userspace calls that read status and events and request state changes. |
| `kstate` | Kernel vdev state changes | `#6741D9` | 7 | full | 2 | 11 | ioctls and the vdev code that faults, degrades, removes, onlines, clears and attaches spares. |
| `sync` | Transactions and sync context | `#E67700` | 9 | full | 1 | 4 | What waits on a suspended pool, and what is written in each txg. |

Default layout rules:

- Column pitch is 400 px. A group starts at `first column * 400` and is `sub-columns` columns wide. A node's x is `(group first column + node sub-col) * 400`.
- Inside a sub-column, stack nodes top to bottom in the order they appear in the section 8 tables, 28 px apart. Node height follows its socket count.
- All groups use band `full` and start at the top.
- The layout must be deterministic. Do not run a force-directed or randomised layout in the page.
- Check the default at "fit all": group titles must be readable and no node may overlap another.

## 8. Nodes

54 nodes. `sub-col` is the node's column inside its group. `functions` are real symbols at the pinned commit (locations in Appendix A); the first one is the node's headline function. Nodes whose role starts with "Shared with the I/O flow graph." use the I/O graph's id, title and context.

### 8.1 I/O pipeline (shared with the I/O graph) (`pipe`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `dev_normal` | Data disks (normal class) | 0 | `hw` | - | - | Shared with the I/O flow graph. The disk that misbehaves: it returns an error, returns wrong data without an error, answers late or not at all, or disappears. |
| `vdev_leaf` | Leaf vdev driver | 0 | `any` | `module/os/linux/zfs/vdev_disk.c` | `vdev_disk_io_done` | Shared with the I/O flow graph. On Linux, after a read or write that failed with EIO, vdev_disk_io_done() checks whether the block device is still there; if not, it asks for the vdev to be marked REMOVED. |
| `vdev_intr` | I/O completion | 0 | `int` | `module/os/linux/zfs/vdev_disk.c` | `vbio_completion`, `zio_interrupt` | Shared with the I/O flow graph. The bio completion records the device's error in the zio and re-enters the pipeline on an interrupt taskq. |
| `zio_taskq` | zio taskqs (issue / interrupt) | 0 | `iss` | `module/zfs/spa.c` | `zio_taskq_dispatch`, `spa_taskq_dispatch` | Shared with the I/O flow graph. Runs completions, the single retry of a failed logical zio (at the head of the issue queue) and the re-execution of failed writes (on the claim issue taskq). |
| `zio_create` | zio create + execute | 0 | `any` | `module/zfs/zio.c` | `zio_wait`, `zio_root` | Shared with the I/O flow graph. zio_wait() is where a caller waits for an I/O; it triggers the deadman after zfs_deadman_ziotime_ms. Re-executed zios (after zpool clear) start here again. |
| `st_vdev_io_start` | VDEV_IO_START | 1 | `any` | `module/zfs/zio.c` | `zio_vdev_io_start` | Shared with the I/O flow graph. For a leaf that is not accessible (dead, removal pending, or known unable to read or write) the zio fails at once with ENXIO and never reaches the disk. |
| `st_vdev_io_done` | VDEV_IO_DONE | 1 | `int` | `module/zfs/zio.c` | `zio_vdev_io_done` | Shared with the I/O flow graph. Lets the vdev type react (mirror: try another side; raidz: verify and reconstruct). An unexpected error on a leaf that still looks accessible starts a device probe. |
| `st_vdev_io_assess` | VDEV_IO_ASSESS | 1 | `int` | `module/zfs/zio.c` | `zio_vdev_io_assess` | Shared with the I/O flow graph. Only a logical zio is retried, once. A leaf error becomes ENXIO when the disk is no longer accessible, so it is blamed on the device rather than on the I/O. |
| `st_cksum_verify` | CHECKSUM_VERIFY | 1 | `int` | `module/zfs/zio.c` | `zio_checksum_verify`, `zio_checksum_error` | Shared with the I/O flow graph. A mismatch on a non-speculative read is counted against the leaf at once and a checksum ereport is started; the error is passed up so redundancy can supply another copy. |
| `vdev_mirror` | Mirror vdev | 1 | `any` | `module/zfs/vdev_mirror.c` | `vdev_mirror_io_done`, `vdev_mirror_child_select` | Shared with the I/O flow graph. On a read error or bad checksum it reads the next child and then rewrites the children that failed. A write to a mirror counts as successful when at least one child succeeded (extra DVA copies all have to succeed). |
| `vdev_raidz` | RAIDZ / dRAID vdev | 1 | `any` | `module/zfs/vdev_raidz.c` | `vdev_raidz_io_done`, `raidz_checksum_verify`, `vdev_raidz_checksum_error` | Shared with the I/O flow graph. When the block does not verify, parity reconstruction finds which column was wrong; that child disk gets the checksum count and an ereport carrying both the good and the bad data, and the column is rewritten. |
| `st_done` | DONE | 1 | `int` | `module/zfs/zio.c` | `zio_done` | Shared with the I/O flow graph. The main bookkeeping point: per-vdev statistics, slow I/O detection, io ereports and error counters for leaves, the error log and data ereport for failed logical zios, finishing checksum reports, and the decision to re-execute or to suspend the pool. Tunables: `zio_slow_io_ms`. |

### 8.2 Kernel records: counters, DTL, error log, suspend (`record`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `vdev_stat` | Per-vdev counters (vdev_stat_t) | 0 | `any` | `module/zfs/vdev.c` | `vdev_stat_update`, `vdev_get_stats_ex` | In-memory statistics of each vdev: operations, bytes, latency histograms, repaired bytes, and the error counters vs_read_errors, vs_write_errors, vs_checksum_errors and vs_slow_ios that zpool status shows as READ, WRITE, CKSUM and SLOW. They are not stored on disk, start at zero when the pool is imported, are zeroed by zpool clear and when a disk is marked REMOVED. vdev_stat_update() also records failed writes in the DTL. |
| `dtl` | Dirty time logs (DTL) | 0 | `any` | `module/zfs/vdev.c` | `vdev_dtl_dirty`, `vdev_dtl_contains`, `vdev_dtl_sync`, `vdev_dtl_reassess`, `vdev_dtl_required` | Per-vdev range trees of txgs whose writes a device missed. A leaf's DTL_MISSING is persisted as a space map in syncing context; parents' DTLs are derived from their children. Used to skip reads from a disk that lacks the data, to decide whether a disk holds the only copy (vdev_dtl_required()), and to bound a resilver. |
| `errlog` | Persistent error log | 0 | `any` | `module/zfs/spa_errlog.c` | `spa_log_error`, `spa_errlog_sync`, `sync_error_list`, `spa_errlog_rotate`, `spa_get_errlog`, `spa_approx_errlog_size` | Bookmarks (objset, object, level, blkid; with the head_errlog feature also the birth txg, per head dataset) of logical blocks that failed. New entries collect in memory (spa_errlist_last, or spa_errlist_scrub while a scrub runs) and are written to ZAP objects in the MOS by spa_errlog_sync(). There are two on-disk logs, last and scrub; when a scan ends the scrub log replaces the last log. |
| `probe` | Device probe | 0 | `int` | `module/zfs/vdev.c` | `vdev_probe`, `vdev_probe_done` | Reads, and if the pool is writable rewrites, the pad areas of labels 1 to 3 of a leaf. Only one probe per disk runs at a time; other zios that want one wait for it. If the disk cannot be both read and (on a writable pool) written, it is marked unable to read or write, a probe_failure ereport is posted and, for probes started by the pipeline, the kernel asks for the disk to be faulted. |
| `deadman` | Deadman (hung I/O detector) | 0 | `thr` | `module/zfs/spa_misc.c` | `spa_deadman`, `vdev_deadman`, `zio_deadman`, `zio_deadman_impl` | Finds I/O that never completes. spa_deadman() runs when a txg sync lasts longer than zfs_deadman_synctime_ms and repeats every zfs_deadman_checktime_ms; vdev_deadman() then looks at the oldest active zio of every leaf. zio_wait() calls zio_deadman() for a waiter older than zfs_deadman_ziotime_ms. It logs and posts deadman ereports; zfs_deadman_failmode (wait, continue, panic) decides what else happens. Nothing is done while the pool is suspended. Tunables: `zfs_deadman_enabled`, `zfs_deadman_synctime_ms`, `zfs_deadman_ziotime_ms`, `zfs_deadman_checktime_ms`, `zfs_deadman_failmode`, `zio_deadman_log_all`. |
| `suspend` | Pool suspend / resume | 0 | `any` | `module/zfs/zio.c` | `zio_suspend`, `zio_resume`, `zio_resume_wait`, `zio_reexecute`, `spa_suspended` | zio_suspend() panics if failmode=panic; otherwise it logs a warning, posts an io_failure ereport, marks the pool suspended and parks the failed root zio under a "godfather" zio. New transactions then wait or fail depending on failmode. zio_resume() (from zpool clear) clears the state, wakes waiters and re-executes every parked zio from the start. Properties: `failmode`. |

### 8.3 Ereports and the zevent queue (`fm`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `ereport_post` | Ereport admission (zfs_ereport_post) | 0 | `any` | `module/zfs/zfs_fm.c` | `zfs_ereport_post`, `zfs_ereport_is_valid`, `zfs_ereport_is_duplicate`, `zfs_is_ratelimiting_event`, `zfs_ereport_clear` | Every ereport passes three checks. Valid: not during tryimport or recovery, only read and write zios, not for a disk already known inaccessible, not a checksum error in a range the disk is known to be missing. Not a duplicate: an io or checksum ereport for a vdev and zio with the same pool, vdev, error, priority, offset, size and bookmark as one seen within zfs_zevent_retain_expire_secs is dropped (EALREADY); data ereports name no vdev and are never treated as duplicates. Not rate limited: delay, deadman and checksum ereports are limited per disk per second; dropped events are added to the readers' dropped count. zfs_ereport_clear() forgets the duplicate history (zpool clear, completed scrub). Delay ereports are only posted while the vdev property slow_io_events is on. Tunables: `zfs_zevent_retain_max`, `zfs_zevent_retain_expire_secs`, `zfs_checksum_events_per_second`, `zfs_slow_io_events_per_second`, `zfs_deadman_events_per_second`. Properties: `slow_io_events`. |
| `ereport_build` | Ereport payload (zfs_ereport_start) | 0 | `any` | `module/zfs/zfs_fm.c` | `zfs_ereport_start`, `fm_ereport_set`, `fm_payload_set`, `fm_ena_generate` | Builds the nvlist: class ereport.fs.zfs. followed by the subclass (io, checksum, data, delay, deadman, probe_failure, io_failure, vdev.open_failed and the other vdev.* classes ...), an ENA shared by all ereports of one logical I/O, a detector naming pool and vdev, and the payload: pool name, state and failmode; vdev guid, type, path, devid, the vdev's error counters and the spares; zio error, flags, stage, priority, offset, size, delay; the bookmark. For checksum, io and delay ereports it adds the vdev's checksum_n / checksum_t, io_n / io_t or slow_io_n / slow_io_t when they differ from the default, which is how zed learns per-disk SERD thresholds. Properties: `checksum_n`, `checksum_t`, `io_n`, `io_t`, `slow_io_n`, `slow_io_t`. |
| `cksum_report` | Checksum ereport (start / finish) | 0 | `any` | `module/zfs/zfs_fm.c` | `zfs_ereport_start_checksum`, `zfs_ereport_finish_checksum`, `zfs_ereport_post_checksum`, `annotate_ecksum` | Checksum ereports carry a description of the damage, which needs the good data. For a mirror or single disk the ereport and a copy of the bad data are attached to the logical zio and finished when it completes; RAIDZ already has both buffers and posts at once. annotate_ecksum() records the bad byte ranges and how many bits were set and cleared. |
| `sysevent` | Resource and sysevent posts | 0 | `any` | `module/zfs/zfs_fm.c` | `zfs_post_state_change`, `zfs_post_remove`, `zfs_event_create`, `spa_event_notify` | Events that are not errors: resource.fs.zfs.statechange (a leaf changed state), resource.fs.zfs.removed, resource.fs.zfs.autoreplace, and sysevent.fs.zfs.* notices such as vdev_spare, vdev_attach, vdev_clear, resilver_finish and scrub_finish. Each carries pool and vdev guid, path and state. |
| `zevent_q` | zevent queue | 0 | `any` | `module/zfs/fm.c` | `zfs_zevent_post`, `zfs_zevent_insert`, `zfs_zevent_drain`, `zfs_zevent_next`, `zfs_zevent_wait` | One in-kernel list of events for all pools. zfs_zevent_post() adds a time and an event id (eid), inserts at the head and wakes waiting readers; when the list holds zfs_zevent_len_max events the oldest is dropped and every reader positioned on it is told how many it missed. Each open /dev/zfs file has its own cursor, so zed and zpool events read independently. Tunables: `zfs_zevent_len_max`. |
| `ioc_events` | Event ioctls (/dev/zfs) | 0 | `syscall` | `module/zfs/zfs_ioctl.c` | `zfs_ioc_events_next`, `zfs_ioc_events_seek`, `zfs_ioc_events_clear` | ZFS_IOC_EVENTS_NEXT returns the next event after the caller's cursor and the dropped count, and blocks until one arrives unless the caller asked not to. SEEK repositions the cursor (zed uses it to start over when its last processed eid is no longer in the queue); CLEAR empties the queue (zpool events -c). |

### 8.4 ZFS event daemon (zed) (`zed`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `udev` | Disk monitor (udev) | 0 | `zed` | `cmd/zed/zed_disk_event.c` | `zed_udev_monitor`, `zed_udev_event` | A zed thread listening to udev. Disk and partition add and remove uevents (including multipath and scsi_debug special cases) become EC_dev_add / EC_dev_remove events for the agents. They never pass through the kernel zevent queue. |
| `zed_loop` | zed event loop | 0 | `zed` | `cmd/zed/zed_event.c` | `zed_event_service`, `zed_event_init`, `zed_event_seek`, `_bump_event_queue_length` | Opens /dev/zfs, skips the events up to the last one it processed (eid and time kept in a state file), then reads events one at a time. Each event goes first to the agents, then to the zedlets, then its eid is saved. When the kernel reports dropped events it doubles zfs_zevent_len_max. |
| `zedlets` | Zedlets (scripts) | 0 | `zed` | `cmd/zed/zed_exec.c` | `zed_exec_process`, `_zed_exec_fork_child` | Executables in the zedlet directory whose names start with the event class, the subclass or "all", run with the event as ZEVENT_* environment variables: notifications (statechange-notify.sh, data-notify.sh, scrub_finish-notify.sh), enclosure LEDs and slot power (statechange-sync-led.sh, deadman-sync-slot_off.sh), and others. Zedlets whose name continues the event name with "-sync-" wait for the zedlets started before them and finish before later ones start; the others run in parallel. They report; the fault decisions are made by the agents. |
| `agents` | Agent dispatcher | 0 | `zed` | `cmd/zed/agents/zfs_agents.c` | `zfs_agent_post_event`, `zfs_agent_consumer_thread`, `zfs_agent_dispatch` | A queue and one thread that hand each event to the agents subscribed to its class. Agents can post events to it too (the diagnosis engine's fault lists). A udev disk-remove event is rewritten here into resource.fs.zfs.removed. |
| `diagnosis` | Diagnosis engine (zfs-diagnosis) | 1 | `zed` | `cmd/zed/agents/zfs_diagnosis.c` | `zfs_fm_recv`, `zfs_fm_serd_record`, `zfs_other_serd_cases`, `zfs_case_solve`, `zfs_fm_timeout` | Keeps one case per disk. Ignores ereports from before the pool was loaded, during import, io and checksum ereports during pool open, ereports for vdevs other than disks and files, and checksum ereports from scrub or resilver I/O. io and checksum ereports feed SERD engines; when one fires (and no other disk under the same parent has an active case) it solves the case: checksum and slow_io at once, io after a 15 second wait for a removal event. A removal resets the engines; a statechange to HEALTHY closes the case. A pool io_failure ereport is turned into a pool fault directly. |
| `serd` | SERD engines | 1 | `zed` | `cmd/zed/agents/fmd_serd.c` | `fmd_serd_create`, `fmd_serd_record`, `fmd_serd_reset`, `fmd_serd_eng_record` | Soft Error Rate Discrimination: an engine remembers the times of its last N events and fires when N of them fall within T. Defaults: 10 io or checksum events within 600 seconds. A slow_io engine exists only when the disk has both slow_io_n and slow_io_t set. Once fired, an engine ignores events until it is reset. |
| `fmd_case` | Fault cases (list.suspect) | 1 | `zed` | `cmd/zed/agents/fmd_api.c` | `fmd_case_open`, `fmd_case_add_suspect`, `fmd_case_solve`, `fmd_fault_mkcode` | zed's small implementation of the illumos fault manager API. Solving a case builds a fault (fault.fs.zfs.vdev.io, vdev.checksum, vdev.slow_io, io_failure_wait / _continue, ...), logs it with its ZFS-8000 message code and posts a list.suspect event back to the agent queue. |
| `retire` | Retire agent (zfs-retire) | 1 | `zed` | `cmd/zed/agents/zfs_retire.c` | `zfs_retire_recv`, `replace_with_spare`, `zfs_vdev_repair` | Acts on fault lists: fault.fs.zfs.vdev.io faults the disk, vdev.checksum and vdev.slow_io degrade it, both with aux "too many errors", then it tries to attach a hot spare. On resource.fs.zfs.removed it requests removal if the kernel has not marked the disk REMOVED yet; on that event or a statechange to REMOVED or FAULTED it attaches a spare when spare_on_remove is set (default on). Spares are tried in order of preference (same rotational type, size, ...) until one attaches. |
| `slm` | Hotplug agent (zfs_mod) | 1 | `zed` | `cmd/zed/agents/zfs_mod.c` | `zfs_slm_event`, `zfs_slm_deliver_event`, `zfs_deliver_add`, `zfs_deliver_check`, `zfs_process_add` | Handles disk-add events and the vdev_check sysevent (a device failed to open at import while autoreplace is on). It looks for a pool vdev with the same devid, physical path, guid or by-vdev path, skips healthy and plainly offlined ones, and onlines it; if that fails and the pool has autoreplace=on and the vdev was a whole disk in a bad state, it labels the new disk and replaces the old one with it. Without autoreplace it onlines again with ZFS_ONLINE_FORCEFAULT so that the failure is reported. Properties: `autoreplace`. |

### 8.5 libzfs and the zpool command (`user`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `admin` | Administrator | 0 | `user` | - | - | The person or script typing the command. Every path in this graph that a command starts begins with a wire from this node; the arrows that come back into a command node are its results, errors and refusals. |
| `zpool_cli` | zpool status / events / clear | 0 | `user` | `cmd/zpool/zpool_main.c` | `zpool_do_status`, `status_callback`, `print_status_config`, `print_error_log`, `zpool_do_events_next`, `zpool_do_clear` | The administrator's view. zpool status prints each vdev's state and READ, WRITE, CKSUM (and with -s SLOW) counts and "errors: N data errors"; with -v the affected files. zpool events prints the queued events; zpool clear clears errors and resumes a suspended pool. |
| `libzfs_ev` | libzfs event reader | 0 | `user` | `lib/libzfs/libzfs_pool.c` | `zpool_events_next` | Wraps ZFS_IOC_EVENTS_NEXT on a caller-supplied /dev/zfs file descriptor, growing the buffer when an event does not fit. Used by zed and by zpool events. |
| `libzfs_status` | libzfs status readers | 0 | `user` | `lib/libzfs/libzfs_config.c` | `zpool_refresh_stats`, `zpool_get_errlog`, `zpool_obj_to_path` | Fetches the pool configuration with statistics (ZFS_IOC_POOL_STATS) and the error log as an array of bookmarks (ZFS_IOC_ERROR_LOG), and turns dataset and object numbers into path names for display. |
| `libzfs_state` | libzfs vdev state calls | 0 | `user` | `lib/libzfs/libzfs_pool.c` | `zpool_vdev_fault`, `zpool_vdev_degrade`, `zpool_vdev_online`, `zpool_vdev_remove_wanted`, `zpool_clear` | Thin wrappers that send ZFS_IOC_VDEV_SET_STATE (faulted, degraded, online, removed) or ZFS_IOC_CLEAR. Used by zed's agents and by zpool online, offline -f and clear. |
| `libzfs_attach` | libzfs replace / spare attach | 0 | `user` | `lib/libzfs/libzfs_pool.c` | `zpool_vdev_attach` | zpool attach and zpool replace, and the agents' spare activation and autoreplace: sends ZFS_IOC_VDEV_ATTACH with the new device and the replacing flag. |

### 8.6 Kernel vdev state changes (`kstate`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `ioc_status` | Status ioctls | 0 | `syscall` | `module/zfs/zfs_ioctl.c` | `zfs_ioc_pool_stats`, `spa_get_stats`, `zfs_ioc_error_log` | Returns the pool configuration with each vdev's vdev_stat_t, the approximate error count and the suspended flag, and copies the error log out as bookmarks. |
| `ioc_state` | Vdev change ioctls | 0 | `syscall` | `module/zfs/zfs_ioctl.c` | `zfs_ioc_vdev_set_state`, `zfs_ioc_vdev_attach` | Dispatches a requested state (online, offline, faulted, degraded, removed) to the vdev code, and attach / replace requests to spa_vdev_attach(). A fault or degrade with an unknown aux reason is treated as "too many errors". |
| `ioc_clear` | zfs_ioc_clear() | 0 | `syscall` | `module/zfs/zfs_ioctl.c` | `zfs_ioc_clear` | zpool clear: optionally rewinds a pool that failed to open, refuses to resume when multihost sees another host, clears the vdev errors under the vdev state lock and resumes suspended I/O. It does not touch the error log. |
| `vdev_fault` | vdev_fault() / vdev_degrade() | 0 | `syscall` | `module/zfs/vdev.c` | `vdev_fault`, `vdev_degrade` | Fault: the leaf is closed and gets no more I/O. The flag is written to the config, but when the pool is opened or imported again only a persistent forced fault (zpool offline -f, aux "external") is kept; a fault requested by zed is dropped and the disk is tried again. If the disk holds the only copy of some data it is reopened and left DEGRADED instead. Degrade: only a flag for the administrator; I/O continues normally. Only leaf vdevs can be faulted or degraded. |
| `vdev_online` | vdev_online() / vdev_remove_wanted() | 0 | `syscall` | `module/zfs/vdev.c` | `vdev_online`, `vdev_remove_wanted` | Online clears the offline flags and reopens the top-level vdev; with ZFS_ONLINE_UNSPARE a spare attached in its place is detached after the resilver. Remove-wanted first probes the disk and refuses (EEXIST) if it still answers, then lets the async thread mark it REMOVED. |
| `vdev_clear` | vdev_clear() | 0 | `syscall` | `module/zfs/vdev.c` | `vdev_clear` | Zeroes the error counters of a vdev and all its children. A faulted, degraded or unreachable vdev gets its flags cleared and is reopened; a still-broken disk fails to open and, because vdev_forcefault is set, its ereport is posted again. Also forgets the vdev's duplicate-ereport history. |
| `vdev_state` | vdev_set_state() | 1 | `any` | `module/zfs/vdev.c` | `vdev_set_state`, `vdev_propagate_state` | Sets a vdev's state and aux reason, closes a leaf that is now dead, posts a statechange event for a leaf (and an ereport.fs.zfs.vdev.* ereport such as vdev.open_failed when it cannot be opened), and propagates upwards: a mirror or raidz with some unhealthy children becomes DEGRADED, with too many it can no longer be opened. |
| `vdev_open` | vdev_open() / vdev_reopen() | 1 | `any` | `module/zfs/vdev.c` | `vdev_reopen`, `vdev_open` | Closes and reopens a vdev tree. A faulted or offline leaf stays so; a missing one stays REMOVED; otherwise it becomes HEALTHY or DEGRADED. A leaf that opened successfully is checked for a needed resilver. |
| `async` | SPA async thread | 1 | `thr` | `module/zfs/spa.c` | `spa_async_request`, `spa_async_thread`, `spa_async_remove`, `spa_async_fault_vdev` | Work that cannot be done in the I/O completion path: marking vdevs REMOVED (counters zeroed, removed event posted), faulting vdevs whose probe failed (DEGRADED and pool suspend instead when the disk holds the only copy), starting a resilver, detaching finished replacements and spares. |
| `spa_attach` | spa_vdev_attach() | 1 | `syscall` | `module/zfs/spa.c` | `spa_vdev_attach`, `spa_spare_activate` | Inserts a spare vdev (for a hot spare) or a replacing vdev above the old disk, adds the new disk with a DTL covering every txg, marks a hot spare active, posts vdev_spare and vdev_attach events and starts a resilver (or a sequential rebuild for a dRAID spare, or defers it while another resilver runs). |
| `resilver_start` | Resilver trigger | 1 | `any` | `module/zfs/dsl_scan.c` | `dsl_scan_assess_vdev`, `vdev_resilver_needed`, `dsl_scan_restart_resilver` | Decides whether a reopened leaf needs a resilver (its DTL is not empty) and asks the async thread to start one, unless a running resilver already covers its txgs; with resilver_defer a newer gap is deferred instead of restarting. dsl_scan_restart_resilver() starts the scan, which continues in the scrub and resilver graph. |

### 8.7 Transactions and sync context (`sync`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `dmu_tx` | dmu_tx (transaction) | 0 | `open` | `module/zfs/dmu_tx.c` | `dmu_tx_assign`, `dmu_tx_try_assign`, `dmu_tx_wait` | Shared with the I/O flow graph. Every change starts by assigning a transaction. On a suspended pool the assignment fails with ESHUTDOWN. dmu_tx_assign() turns that into EIO when failmode=continue (unless the caller passed DMU_TX_SUSPEND), otherwise into a retry, so a caller that waits blocks until the pool resumes. |
| `spa_sync` | spa_sync() | 0 | `sync` | `module/zfs/spa.c` | `spa_sync`, `spa_sync_iterate_to_convergence` | Shared with the I/O flow graph. Each txg: arms the deadman, writes the pending error-log entries, runs the scan (which may finish a scrub or resilver), writes dirty DTLs through vdev_sync(), and finally rewrites the labels and uberblocks. |
| `uberblock` | Uberblock + label update | 0 | `sync` | `module/zfs/vdev_label.c` | `spa_sync_rewrite_vdev_config` | Shared with the I/O flow graph. If writing the labels and uberblocks fails (vdev_config_sync() returns an error), the txg cannot be committed: the pool suspends and spa_sync() waits for zpool clear, then tries again. |
| `scan_done` | dsl_scan_done() | 0 | `sync` | `module/zfs/dsl_scan.c` | `dsl_scan_done` | The end of a scrub or resilver: DTLs are reassessed, the error log is rotated (scrub log becomes last log, also when the scan was cancelled), the duplicate-ereport history is cleared after a complete scan, scrub_finish or resilver_finish is posted, and finished replacements are detached by the async thread. |

## 9. Wires

121 wires. A wire runs from the node that hands something over to the node that receives it. `on paths` lists the section 10 paths that use the wire.

| wire | from | to | type | label | on paths |
|---|---|---|---|---|---|
| E001 | `dev_normal` | `vdev_intr` | `bio` | bio completion: vbio_completion() stores the device status in io_error (bi_status_to_errno()); a disk that returns wrong data completes without an error | cksum_repair, io_error_mirror, slow_io, kernel_fault, device_removed, suspend_clear, permanent_error |
| E002 | `vdev_intr` | `zio_taskq` | `zio` | zio_delay_interrupt() -> zio_interrupt(): queued on the interrupt taskq | cksum_repair, io_error_mirror, slow_io, kernel_fault, device_removed, suspend_clear, permanent_error |
| E003 | `zio_taskq` | `st_vdev_io_done` | `zio` | an interrupt-taskq worker resumes the pipeline | cksum_repair, io_error_mirror, slow_io, deadman, kernel_fault, device_removed, suspend_clear, permanent_error |
| E004 | `st_vdev_io_start` | `zio_taskq` | `zio` | leaf not accessible (dead, removal pending, or unable to read or write): io_error = ENXIO and zio_interrupt() without touching the disk | device_removed, suspend_clear |
| E005 | `st_vdev_io_done` | `st_vdev_io_assess` | `zio` | zio_vdev_io_done() -> zio_vdev_io_assess(): result of this vdev level | cksum_repair, io_error_mirror, slow_io, device_removed, suspend_clear, permanent_error |
| E006 | `st_vdev_io_done` | `probe` | `ctl` | unexpected error on a leaf that still looks accessible and is not being removed: vdev_probe(vd, zio) | io_error_mirror, kernel_fault, suspend_clear |
| E007 | `st_vdev_io_done` | `vdev_leaf` | `ctl` | vdev_op_io_done(): vdev_disk_io_done() | io_error_mirror, device_removed |
| E008 | `vdev_leaf` | `async` | `ctl` | EIO and zfs_check_disk_status() finds the block device gone: vdev_remove_wanted = TRUE, spa_async_request(SPA_ASYNC_REMOVE) | device_removed |
| E009 | `st_vdev_io_assess` | `st_cksum_verify` | `abd` | read: data arrived | cksum_repair, permanent_error |
| E010 | `st_vdev_io_assess` | `st_done` | `zio` | this level is finished: success, or an error that is not retried here (a leaf error is never retried; it becomes ENXIO if the disk is no longer accessible) | cksum_repair, io_error_mirror, slow_io, device_removed, suspend_clear |
| E011 | `st_vdev_io_assess` | `zio_taskq` | `zio` | logical zio (no vdev) failed and was not retried yet: ZIO_FLAG_IO_RETRY set, dispatched to the issue taskq | suspend_clear |
| E012 | `zio_taskq` | `st_vdev_io_start` | `zio` | the retry runs VDEV_IO_START again, cutting in line (zio_requeue_io_start_cut_in_line) | suspend_clear |
| E013 | `st_cksum_verify` | `vdev_stat` | `ctl` | zio_checksum_error() mismatch on a non-speculative read: vs_checksum_errors++ on the leaf | cksum_repair, permanent_error |
| E014 | `st_cksum_verify` | `cksum_report` | `event` | zfs_ereport_start_checksum(): a copy of the bad data is kept for the report | cksum_repair, permanent_error |
| E015 | `st_cksum_verify` | `st_done` | `abd` | io_error = ECKSUM, passed up so another copy can be tried | cksum_repair, permanent_error |
| E016 | `st_done` | `st_vdev_io_done` | `ctl` | child done: zio_notify_parent() lets the mirror continue | cksum_repair, io_error_mirror |
| E017 | `st_vdev_io_done` | `vdev_mirror` | `zio` | vdev_mirror_io_done(): no good copy yet -> vdev_mirror_child_select() picks the next child | cksum_repair, io_error_mirror |
| E018 | `vdev_mirror` | `st_vdev_io_start` | `zio` | zio_vdev_child_io(): read of the next child; once good data is in hand, repair writes (ZIO_FLAG_IO_REPAIR, ZIO_FLAG_SELF_HEAL) to the children that failed | cksum_repair, io_error_mirror |
| E019 | `st_vdev_io_done` | `vdev_raidz` | `zio` | vdev_raidz_io_done(): raidz_checksum_verify() fails, parity reconstruction finds the bad column | cksum_repair |
| E020 | `vdev_raidz` | `vdev_stat` | `ctl` | vdev_raidz_checksum_error(): vs_checksum_errors++ on the child disk of the bad column | cksum_repair |
| E021 | `vdev_raidz` | `cksum_report` | `event` | zfs_ereport_post_checksum() with the reconstructed good data and the bad column data | cksum_repair |
| E022 | `vdev_raidz` | `st_vdev_io_start` | `zio` | repair write of the reconstructed column (ZIO_FLAG_IO_REPAIR, ZIO_FLAG_SELF_HEAL) | cksum_repair |
| E023 | `st_done` | `vdev_stat` | `ctl` | zio_done(): vdev_stat_update(); slow I/O on a live leaf: vs_slow_ios++; failed I/O (not ECKSUM) on a live leaf: vs_read_errors++ or vs_write_errors++ unless its ereport was a duplicate | io_error_mirror, slow_io, device_removed |
| E024 | `st_done` | `ereport_post` | `event` | failed I/O (not ECKSUM) on a leaf that is not dead: zfs_ereport_post(ereport.fs.zfs.io) | io_error_mirror |
| E025 | `st_done` | `ereport_post` | `event` | io_delay >= zio_slow_io_ms on a live leaf and the vdev's slow_io_events is on: zfs_ereport_post(ereport.fs.zfs.delay) | slow_io |
| E026 | `st_done` | `ereport_post` | `event` | logical zio failed: zfs_ereport_post(ereport.fs.zfs.data) with the bookmark and no vdev | permanent_error |
| E027 | `st_done` | `errlog` | `ctl` | logical zio failed (EIO, or any error unless speculative or not propagated): spa_log_error(bookmark, birth txg) adds it to spa_errlist_last, or spa_errlist_scrub while a scrub runs | permanent_error |
| E028 | `st_done` | `cksum_report` | `event` | logical zio done: each pending report's zcr_finish() -> zfs_ereport_finish_checksum() with the good data, or with none if the read failed | cksum_repair, permanent_error |
| E029 | `st_done` | `suspend` | `ctl` | root logical zio marked ZIO_POST_SUSPEND (a read or free that failed with ENXIO and failmode is not continue, an allocating write that failed with ENOSPC, or a must-succeed zio that cannot be re-executed): zio_suspend(ZIO_SUSPEND_IOERR) | suspend_clear |
| E030 | `st_done` | `zio_taskq` | `zio` | allocating write failed (not ENOSPC, not CANFAIL): ZIO_POST_REEXECUTE; the root zio re-executes the whole tree on the claim issue taskq, indefinitely while it keeps failing | suspend_clear |
| E031 | `vdev_stat` | `dtl` | `dtl` | vdev_stat_update(): write with a txg failed on a leaf (ENXIO from a missing disk; a plain EIO only on the retried attempt): vdev_dtl_dirty(DTL_PARTIAL) up the tree and vdev_dtl_dirty(DTL_MISSING) on the leaf, top-level marked VDD_DTL | device_removed |
| E032 | `probe` | `ereport_post` | `event` | probe failed: zfs_ereport_post(ereport.fs.zfs.probe_failure) | kernel_fault |
| E033 | `probe` | `async` | `ctl` | probe started by the pipeline failed: vdev_fault_wanted = TRUE, spa_async_request(SPA_ASYNC_FAULT_VDEV) | kernel_fault, suspend_clear |
| E034 | `async` | `vdev_state` | `ctl` | spa_async_fault_vdev(): vdev_set_state(FAULTED, ERR_EXCEEDED), or DEGRADED when vdev_dtl_required() says the disk holds the only copy | kernel_fault, suspend_clear |
| E035 | `async` | `suspend` | `ctl` | a required disk was lost: zio_suspend(ZIO_SUSPEND_IOERR) | suspend_clear |
| E036 | `async` | `vdev_state` | `ctl` | spa_async_remove(): vdev_set_state(REMOVED); read, write and checksum counters zeroed | device_removed |
| E037 | `async` | `sysevent` | `event` | zfs_post_remove(by_kernel): resource.fs.zfs.removed | device_removed |
| E038 | `async` | `resilver_start` | `ctl` | SPA_ASYNC_RESILVER: dsl_scan_restart_resilver(), unless a rebuild is active or a resilver is running with resilver_defer enabled | device_removed |
| E039 | `spa_sync` | `deadman` | `ctl` | spa_sync() schedules spa_deadman() to run after spa_deadman_synctime; it re-arms itself every zfs_deadman_checktime_ms | deadman |
| E040 | `zio_create` | `deadman` | `ctl` | zio_wait() still waiting after zfs_deadman_ziotime_ms: zio_deadman() | deadman |
| E041 | `deadman` | `ereport_post` | `event` | oldest active zio of a leaf older than the limit: zio_deadman() logs the tree and posts zfs_ereport_post(ereport.fs.zfs.deadman) for each leaf zio (every zio with zio_deadman_log_all) | deadman |
| E042 | `deadman` | `zio_taskq` | `zio` | zfs_deadman_failmode=continue: an active leaf zio with no children gets io_error = EINTR and zio_interrupt(); failmode panic: fm_panic() | deadman |
| E043 | `ereport_post` | `ereport_build` | `event` | zfs_ereport_is_valid(), zfs_ereport_is_duplicate() and zfs_is_ratelimiting_event() passed: zfs_ereport_start() | cksum_repair, io_error_mirror, slow_io, deadman, kernel_fault, suspend_clear, permanent_error |
| E044 | `ereport_build` | `zevent_q` | `event` | fm_ereport_set() class and detector, payload; zfs_zevent_post(): inserted at the head, the oldest dropped at zfs_zevent_len_max | io_error_mirror, slow_io, deadman, kernel_fault, suspend_clear, permanent_error |
| E045 | `cksum_report` | `ereport_post` | `ctl` | zfs_ereport_start_checksum() / zfs_ereport_post_checksum(): the same validity, duplicate and rate-limit checks (zfs_checksum_events_per_second) | cksum_repair |
| E046 | `ereport_build` | `cksum_report` | `event` | checksum ereport built by zfs_ereport_start(): hung on io_logical->io_cksum_report (start) or annotated at once (post) | cksum_repair |
| E047 | `cksum_report` | `zevent_q` | `event` | annotate_ecksum() adds bad ranges and bit counts (an empty result is dropped); zfs_zevent_post() | cksum_repair, permanent_error |
| E048 | `sysevent` | `zevent_q` | `event` | zfs_event_create() -> zfs_zevent_post(); sysevents through spa_event_post() | zed_fault, cksum_degrade, kernel_fault, device_removed, permanent_error |
| E049 | `vdev_state` | `sysevent` | `event` | leaf changed state (not its initial open): zfs_post_state_change() -> resource.fs.zfs.statechange with the previous state | zed_fault, cksum_degrade, kernel_fault, device_removed |
| E050 | `zevent_q` | `ioc_events` | `event` | zfs_zevent_next(): nvlist_dup() of the next event after this reader's cursor, plus its dropped count and the rate-limited count | cksum_repair, io_error_mirror, slow_io, deadman, zed_fault, cksum_degrade, kernel_fault, device_removed, suspend_clear, permanent_error, status_events |
| E051 | `ioc_events` | `zevent_q` | `ctl` | zfs_ioc_events_next(): zfs_zevent_next(); nothing new and blocking: zfs_zevent_wait() until zfs_zevent_post() broadcasts | cksum_repair, io_error_mirror, slow_io, deadman, zed_fault, cksum_degrade, kernel_fault, device_removed, suspend_clear, permanent_error, status_events |
| E052 | `ioc_events` | `libzfs_ev` | `event` | put_nvlist() of the event, zc_cookie = dropped count | cksum_repair, io_error_mirror, slow_io, deadman, zed_fault, cksum_degrade, kernel_fault, device_removed, suspend_clear, permanent_error, status_events |
| E053 | `libzfs_ev` | `ioc_events` | `ctl` | zfs_ioctl(ZFS_IOC_EVENTS_NEXT) on the caller's own /dev/zfs file descriptor | cksum_repair, io_error_mirror, slow_io, deadman, zed_fault, cksum_degrade, kernel_fault, device_removed, suspend_clear, permanent_error, status_events |
| E054 | `zed_loop` | `libzfs_ev` | `ctl` | zed_event_service(): zpool_events_next(ZEVENT_NONE) blocks for the next event | cksum_repair, io_error_mirror, slow_io, deadman, zed_fault, cksum_degrade, kernel_fault, device_removed, suspend_clear, permanent_error |
| E055 | `libzfs_ev` | `zed_loop` | `event` | event nvlist (eid, time, class, payload) and the dropped count | cksum_repair, io_error_mirror, slow_io, deadman, zed_fault, cksum_degrade, kernel_fault, device_removed, suspend_clear, permanent_error |
| E056 | `zed_loop` | `zevent_q` | `ctl` | events were dropped: _bump_event_queue_length() doubles zfs_zevent_len_max through /sys/module/zfs/parameters, up to a zed limit | slow_io |
| E057 | `zed_loop` | `agents` | `event` | zfs_agent_post_event(class, NULL, nvl): a copy queued for the agent thread before any zedlet runs | cksum_repair, io_error_mirror, slow_io, zed_fault, cksum_degrade, kernel_fault, device_removed, suspend_clear |
| E058 | `zed_loop` | `zedlets` | `event` | zed_exec_process(): ZEVENT_* environment; zedlets named after the class, the subclass or "all" are forked | slow_io, deadman, permanent_error |
| E059 | `dev_normal` | `udev` | `event` | Linux udev uevent: the disk was removed or added | device_removed |
| E060 | `udev` | `agents` | `event` | zed_udev_event() -> zfs_agent_post_event(EC_dev_add or EC_dev_remove); a disk remove is rewritten to resource.fs.zfs.removed | device_removed |
| E061 | `agents` | `diagnosis` | `event` | zfs_agent_dispatch(): ereport.fs.zfs.*, resource.fs.zfs.* and some sysevents -> fmd_module_recv(zfs-diagnosis) | cksum_repair, io_error_mirror, slow_io, zed_fault, cksum_degrade, device_removed, suspend_clear |
| E062 | `agents` | `retire` | `event` | list.suspect, resource.fs.zfs.removed, resource.fs.zfs.statechange and sysevent vdev_remove -> fmd_module_recv(zfs-retire) | slow_io, zed_fault, cksum_degrade, kernel_fault, device_removed |
| E063 | `agents` | `slm` | `event` | EC_dev_* events and the vdev_check sysevent -> zfs_slm_event() -> zfs_deliver_add() / zfs_deliver_check() | device_removed |
| E064 | `diagnosis` | `serd` | `ctl` | io, checksum (or delay) ereport: fmd_serd_create() on first use with N and T from the payload, else 10 events in 600 s; zfs_fm_serd_record() -> fmd_serd_record() | cksum_repair, io_error_mirror, slow_io, zed_fault, cksum_degrade |
| E065 | `serd` | `diagnosis` | `ctl` | fmd_serd_eng_record(): fired when the oldest of the last N events is at most T old; ignored if another disk under the same parent has an active case (zfs_other_serd_cases()) | slow_io, zed_fault, cksum_degrade |
| E066 | `diagnosis` | `fmd_case` | `event` | checksum or slow_io engine fired: zfs_case_solve(fault.fs.zfs.vdev.checksum or fault.fs.zfs.vdev.slow_io) at once | slow_io, cksum_degrade |
| E067 | `diagnosis` | `fmd_case` | `event` | io engine fired: fmd_timer_install(zfs_remove_timeout, 15 s) in case a removal explains the errors; zfs_fm_timeout() then solves fault.fs.zfs.vdev.io | zed_fault |
| E068 | `diagnosis` | `fmd_case` | `event` | ereport.fs.zfs.io_failure: fault.fs.zfs.io_failure_wait or io_failure_continue from the payload's failmode, no SERD | suspend_clear |
| E069 | `diagnosis` | `serd` | `ctl` | resource.fs.zfs.removed for a disk with an open case: removal timer cancelled, fmd_serd_reset() on its io, checksum and slow_io engines | device_removed |
| E070 | `fmd_case` | `agents` | `event` | fmd_case_add_suspect(): list.suspect with the fault, fmd_fault_mkcode() message code and case uuid -> zfs_agent_post_event() | slow_io, zed_fault, cksum_degrade |
| E071 | `retire` | `libzfs_state` | `ctl` | fault.fs.zfs.vdev.io: zpool_vdev_fault(); vdev.checksum or vdev.slow_io: zpool_vdev_degrade(); aux VDEV_AUX_ERR_EXCEEDED | slow_io, zed_fault, cksum_degrade |
| E072 | `retire` | `libzfs_state` | `ctl` | resource.fs.zfs.removed for a disk the kernel has not marked REMOVED yet: zpool_vdev_remove_wanted() | device_removed |
| E073 | `retire` | `libzfs_attach` | `ctl` | replace_with_spare() (after a fault or degrade, or a removal with spare_on_remove): spares sorted by spare_is_preferred(), zpool_vdev_attach(replacing) until one succeeds | zed_fault, cksum_degrade, kernel_fault |
| E074 | `slm` | `libzfs_state` | `ctl` | zfs_process_add() for the matching vdev (devid_iter() and friends): zpool_vdev_online(ZFS_ONLINE_CHECKREMOVE, ZFS_ONLINE_UNSPARE) | device_removed |
| E075 | `slm` | `libzfs_attach` | `ctl` | online failed, autoreplace=on, whole disk in a bad state: label the new disk, zpool_vdev_attach(replacing), sequential rebuild tried first | device_removed |
| E076 | `zpool_cli` | `libzfs_ev` | `ctl` | zpool events [-f]: zpool_do_events_next() -> zpool_events_next() on a fresh /dev/zfs descriptor | status_events |
| E077 | `libzfs_ev` | `zpool_cli` | `event` | each event printed as one line, or as the whole nvlist with -v | status_events |
| E078 | `zpool_cli` | `libzfs_status` | `ctl` | zpool status: zpool_open() -> zpool_refresh_stats(); with -v also zpool_get_errlog() | permanent_error, status_events |
| E079 | `libzfs_status` | `ioc_status` | `ctl` | ZFS_IOC_POOL_STATS; ZFS_IOC_ERROR_LOG (buffer doubled on ENOMEM) | permanent_error, status_events |
| E080 | `ioc_status` | `vdev_stat` | `ctl` | spa_get_stats(): config with vdev_config_generate_stats() -> vdev_get_stats_ex() for every vdev | status_events |
| E081 | `ioc_status` | `errlog` | `ctl` | spa_approx_errlog_size() for the count; spa_get_errlog(): the scrub log, the last log (unless a scrub just finished) and the pending in-memory entries | permanent_error, status_events |
| E082 | `ioc_status` | `libzfs_status` | `ctl` | put_nvlist(): config with states, counters, ZPOOL_CONFIG_ERRCOUNT and ZPOOL_CONFIG_SUSPENDED; or the bookmark array | permanent_error, status_events |
| E083 | `libzfs_status` | `zpool_cli` | `ctl` | print_status_config(): READ, WRITE, CKSUM (SLOW with -s) per vdev; "errors: N data errors"; with -v print_error_log() names each file with zpool_obj_to_path() | permanent_error, status_events |
| E084 | `zpool_cli` | `libzfs_state` | `ctl` | zpool clear [pool [device]]: zpool_do_clear() -> zpool_clear() | suspend_clear |
| E085 | `libzfs_state` | `ioc_state` | `ctl` | zfs_ioctl(ZFS_IOC_VDEV_SET_STATE) with FAULTED, DEGRADED, ONLINE or REMOVED | zed_fault, cksum_degrade, device_removed |
| E086 | `libzfs_state` | `ioc_clear` | `ctl` | zfs_ioctl(ZFS_IOC_CLEAR) with the rewind policy | suspend_clear |
| E087 | `libzfs_attach` | `ioc_state` | `ctl` | zfs_ioctl(ZFS_IOC_VDEV_ATTACH) with the replacing flag | zed_fault, cksum_degrade, kernel_fault, device_removed |
| E088 | `ioc_state` | `vdev_fault` | `ctl` | VDEV_STATE_FAULTED: vdev_fault(); VDEV_STATE_DEGRADED: vdev_degrade() | zed_fault, cksum_degrade |
| E089 | `ioc_state` | `vdev_online` | `ctl` | VDEV_STATE_ONLINE: vdev_online(); VDEV_STATE_REMOVED: vdev_remove_wanted() | device_removed |
| E090 | `ioc_state` | `spa_attach` | `ctl` | zfs_ioc_vdev_attach(): spa_vdev_attach(replacing) | zed_fault, cksum_degrade, kernel_fault, device_removed |
| E091 | `vdev_fault` | `vdev_state` | `ctl` | vdev_fault(): vdev_set_state(FAULTED); if vdev_dtl_required() the disk is reopened and set DEGRADED instead | zed_fault |
| E092 | `vdev_fault` | `vdev_state` | `ctl` | vdev_degrade(): vdev_set_state(DEGRADED) unless already faulted or degraded | cksum_degrade |
| E093 | `vdev_online` | `vdev_open` | `ctl` | vdev_online(): offline flags cleared, vdev_reopen() of the top-level vdev | device_removed |
| E094 | `vdev_online` | `probe` | `ctl` | vdev_remove_wanted(): zio_wait(vdev_probe()) must fail, else EEXIST | device_removed |
| E095 | `vdev_online` | `async` | `ctl` | vdev_remove_wanted = TRUE, spa_async_request(SPA_ASYNC_REMOVE_BY_USER) | device_removed |
| E096 | `vdev_open` | `vdev_state` | `ctl` | vdev_reopen(): vdev_open() sets the new state, then vdev_propagate_state() and the parents' vdev_op_state_change() | device_removed, suspend_clear |
| E097 | `vdev_open` | `resilver_start` | `ctl` | leaf opened (not a reopen for a scrub): dsl_scan_assess_vdev() | device_removed |
| E098 | `dtl` | `resilver_start` | `dtl` | vdev_resilver_needed(): the leaf's DTL_MISSING range (lowest and highest txg) | device_removed |
| E099 | `resilver_start` | `async` | `ctl` | resilver needed and none running: spa_async_request(SPA_ASYNC_RESILVER); running but older than the gap: restart, or vdev_defer_resilver() with resilver_defer | device_removed |
| E100 | `ioc_clear` | `vdev_clear` | `ctl` | spa_vdev_state_enter(); vdev_clear(spa, vd), the whole pool when no device was named | suspend_clear |
| E101 | `vdev_clear` | `vdev_stat` | `ctl` | read, write, checksum, Direct I/O verify and slow counters zeroed, recursively | suspend_clear |
| E102 | `vdev_clear` | `vdev_open` | `ctl` | faulted, degraded or unable to read or write: flags cleared, vdev_forcefault set, vdev_reopen() of the top-level vdev | suspend_clear |
| E103 | `vdev_clear` | `sysevent` | `event` | spa_event_notify(ESC_ZFS_VDEV_CLEAR) | suspend_clear |
| E104 | `vdev_clear` | `ereport_post` | `ctl` | zfs_ereport_clear(): the vdev's duplicate-ereport history is dropped | suspend_clear |
| E105 | `ioc_clear` | `suspend` | `ctl` | zio_resume(), unless multihost detects another host (spa_mmp_remote_host_activity(): EREMOTEIO) | suspend_clear |
| E106 | `suspend` | `zio_create` | `zio` | zio_resume(): suspended state cleared, cv_broadcast(); zio_reexecute() of the parked tree, each zio from its first stage (__zio_execute()) | suspend_clear |
| E107 | `suspend` | `ereport_post` | `event` | zfs_ereport_post(ereport.fs.zfs.io_failure); the payload carries the pool's failmode | suspend_clear |
| E108 | `suspend` | `dmu_tx` | `tx` | dmu_tx_try_assign() returns ESHUTDOWN; failmode=continue (and no DMU_TX_SUSPEND): dmu_tx_assign() returns EIO; otherwise a waiting caller blocks in dmu_tx_wait() -> txg_wait_synced_flags() until resume | suspend_clear |
| E109 | `spa_sync` | `uberblock` | `tx` | spa_sync_rewrite_vdev_config() | suspend_clear |
| E110 | `uberblock` | `suspend` | `ctl` | vdev_config_sync() failed: zio_suspend(), then zio_resume_wait() blocks spa_sync() until zpool clear, and the write is tried again | suspend_clear |
| E111 | `spa_sync` | `errlog` | `ctl` | spa_errlog_sync(): pending entries written with sync_error_list(); after a scan the old last log is deleted (delete_errlog()) and the scrub log becomes the last log | permanent_error |
| E112 | `spa_sync` | `dtl` | `dtl` | vdev_sync() -> vdev_dtl_sync(): each dirty leaf's DTL_MISSING written as a space map | device_removed |
| E113 | `spa_sync` | `scan_done` | `ctl` | dsl_scan_sync(): the scan has visited everything -> dsl_scan_done(complete) | permanent_error |
| E114 | `scan_done` | `errlog` | `ctl` | spa_errlog_rotate(): spa_scrub_finished set, applied by the next spa_errlog_sync() | permanent_error |
| E115 | `scan_done` | `ereport_post` | `ctl` | complete scan: zfs_ereport_clear(spa, NULL) drops the whole duplicate-ereport history | permanent_error |
| E116 | `scan_done` | `sysevent` | `event` | spa_event_notify(ESC_ZFS_RESILVER_FINISH or ESC_ZFS_SCRUB_FINISH) | permanent_error |
| E117 | `spa_attach` | `vdev_state` | `ctl` | vdev_add_parent(old disk, vdev_spare_ops or vdev_replacing_ops), new disk added, vdev_propagate_state() | zed_fault |
| E118 | `spa_attach` | `dtl` | `dtl` | vdev_dtl_dirty(new disk, DTL_MISSING, TXG_INITIAL to the current txg): it is missing everything | zed_fault, device_removed |
| E119 | `spa_attach` | `sysevent` | `event` | spa_spare_activate(); spa_event_notify(ESC_ZFS_VDEV_SPARE), then ESC_ZFS_VDEV_ATTACH | zed_fault |
| E120 | `spa_attach` | `resilver_start` | `ctl` | dsl_scan_restart_resilver(), or vdev_rebuild() for a sequential rebuild, or vdev_defer_resilver() while another resilver runs | zed_fault, cksum_degrade, device_removed |
| E121 | `admin` | `zpool_cli` | `ctl` | runs zpool status [-v] or zpool events | status_events |

## 10. Paths

11 named paths, 307 steps in total. Each step is one wire; the caption for a step is that wire's label. Every wire in section 9 is on at least one path. The category is the heading the path is listed under in the left panel. Path syntax, alternatives and notes are as defined in section 10 of `../zfs-io-flow-diagram-spec.md`.

### 10.1 `cksum_repair` - Checksum error repaired

Category: Detection. A disk returns wrong data without reporting an error. CHECKSUM_VERIFY (mirror) or the RAIDZ reconstruction finds the bad copy, counts it against the disk and prepares a checksum ereport, and redundancy supplies and rewrites good data. zed records the event in the disk's checksum SERD engine.

Alternatives:
- `layout`: `mirror` Mirror top-level vdev: the leaf child verifies the checksum, the ereport is finished when the logical read completes; `raidz` RAIDZ / dRAID top-level vdev: reconstruction identifies the bad column and the ereport is posted at once

```
 1  E001  dev_normal -> vdev_intr  "the read completes without an error, but the data is wrong"
 2  E002  vdev_intr -> zio_taskq
 3  E003  zio_taskq -> st_vdev_io_done
 4  E005  st_vdev_io_done -> st_vdev_io_assess  [layout: mirror]  "the leaf child under the mirror"
 5  E009  st_vdev_io_assess -> st_cksum_verify  [layout: mirror]
 6  E013  st_cksum_verify -> vdev_stat  [layout: mirror]
 7  E014  st_cksum_verify -> cksum_report  [layout: mirror]
 8  E045  cksum_report -> ereport_post  [layout: mirror]
 9  E043  ereport_post -> ereport_build  [layout: mirror]
10  E046  ereport_build -> cksum_report  [layout: mirror]  "kept on the logical zio, not posted yet"
11  E015  st_cksum_verify -> st_done  [layout: mirror]
12  E016  st_done -> st_vdev_io_done  [layout: mirror]
13  E017  st_vdev_io_done -> vdev_mirror  [layout: mirror]
14  E018  vdev_mirror -> st_vdev_io_start  [layout: mirror]  "read the next child, then rewrite the bad one"
15  E019  st_vdev_io_done -> vdev_raidz  [layout: raidz]  "all data columns arrived; the block does not verify"
16  E020  vdev_raidz -> vdev_stat  [layout: raidz]
17  E021  vdev_raidz -> cksum_report  [layout: raidz]
18  E045  cksum_report -> ereport_post  [layout: raidz]
19  E043  ereport_post -> ereport_build  [layout: raidz]
20  E046  ereport_build -> cksum_report  [layout: raidz]  "annotated and posted at once"
21  E047  cksum_report -> zevent_q  [layout: raidz]
22  E022  vdev_raidz -> st_vdev_io_start  [layout: raidz]
23  E005  st_vdev_io_done -> st_vdev_io_assess  "the read finishes its vdev stages"
24  E010  st_vdev_io_assess -> st_done  "success: good data was found"
25  E028  st_done -> cksum_report  [layout: mirror]  "the logical read is done: finished with the good data"
26  E047  cksum_report -> zevent_q  [layout: mirror]
27  E054  zed_loop -> libzfs_ev
28  E053  libzfs_ev -> ioc_events
29  E051  ioc_events -> zevent_q
30  E050  zevent_q -> ioc_events
31  E052  ioc_events -> libzfs_ev
32  E055  libzfs_ev -> zed_loop
33  E057  zed_loop -> agents
34  E061  agents -> diagnosis
35  E064  diagnosis -> serd  "one more event in the checksum engine; it has not fired"
```
Ends: The caller got correct data, the disk's CKSUM count in zpool status is one higher, and the bad copy has been rewritten. By default ten such events within ten minutes degrade the disk (path cksum_degrade).

### 10.2 `io_error_mirror` - I/O error on one side of a mirror

Category: Detection. A read fails with EIO on one mirror child. The leaf zio is not retried. The error is counted (READ column), an io ereport is posted, the disk is probed, and the mirror reads the other side and rewrites the failed one.

```
 1  E001  dev_normal -> vdev_intr  "the read fails with EIO"
 2  E002  vdev_intr -> zio_taskq
 3  E003  zio_taskq -> st_vdev_io_done
 4  E007  st_vdev_io_done -> vdev_leaf  "the disk is still present, so nothing happens"
 5  E006  st_vdev_io_done -> probe  "the label pad areas still read and write: the probe passes"
 6  E005  st_vdev_io_done -> st_vdev_io_assess
 7  E010  st_vdev_io_assess -> st_done  "EIO, passed up"
 8  E024  st_done -> ereport_post
 9  E043  ereport_post -> ereport_build
10  E044  ereport_build -> zevent_q
11  E023  st_done -> vdev_stat  "READ count +1"
12  E016  st_done -> st_vdev_io_done
13  E017  st_vdev_io_done -> vdev_mirror
14  E018  vdev_mirror -> st_vdev_io_start  "read the other side, then rewrite the failed one"
15  E054  zed_loop -> libzfs_ev
16  E053  libzfs_ev -> ioc_events
17  E051  ioc_events -> zevent_q
18  E050  zevent_q -> ioc_events
19  E052  ioc_events -> libzfs_ev
20  E055  libzfs_ev -> zed_loop
21  E057  zed_loop -> agents
22  E061  agents -> diagnosis
23  E064  diagnosis -> serd  "one more event in the io engine; it has not fired"
```
Ends: The application got good data from the other side. The disk shows one READ error and its io SERD engine holds one event. Repeated errors continue in path zed_fault.

### 10.3 `slow_io` - Slow I/O (delay event)

Category: Detection. An I/O succeeds but took longer than zio_slow_io_ms. It is counted in the SLOW column and posted as a delay ereport (rate limited). zed only acts on it when the disk has the slow_io_n and slow_io_t vdev properties.

Alternatives:
- `serd`: `off` slow_io_n / slow_io_t not set (default): zed only passes the event to zedlets; `on` Both vdev properties set: a slow_io SERD engine can degrade the disk

```
 1  E001  dev_normal -> vdev_intr  "the I/O succeeds, but only after more than 30 s"
 2  E002  vdev_intr -> zio_taskq
 3  E003  zio_taskq -> st_vdev_io_done
 4  E005  st_vdev_io_done -> st_vdev_io_assess
 5  E010  st_vdev_io_assess -> st_done  "success"
 6  E023  st_done -> vdev_stat  "SLOW count +1, even if the ereport is rate limited"
 7  E025  st_done -> ereport_post
 8  E043  ereport_post -> ereport_build  "at most zfs_slow_io_events_per_second per disk"
 9  E044  ereport_build -> zevent_q
10  E054  zed_loop -> libzfs_ev
11  E053  libzfs_ev -> ioc_events
12  E051  ioc_events -> zevent_q
13  E050  zevent_q -> ioc_events  "the dropped count includes rate-limited events"
14  E052  ioc_events -> libzfs_ev
15  E055  libzfs_ev -> zed_loop
16  E056  zed_loop -> zevent_q  "only when events were dropped"
17  E057  zed_loop -> agents
18  E058  zed_loop -> zedlets  [serd: off]
19  E061  agents -> diagnosis  [serd: on]
20  E064  diagnosis -> serd  [serd: on]
21  E065  serd -> diagnosis  [serd: on]  "slow_io_n delay events within slow_io_t seconds"
22  E066  diagnosis -> fmd_case  [serd: on]  "fault.fs.zfs.vdev.slow_io"
23  E070  fmd_case -> agents  [serd: on]
24  E062  agents -> retire  [serd: on]
25  E071  retire -> libzfs_state  [serd: on]  "zpool_vdev_degrade(), continued as in path cksum_degrade"
```
Ends: The I/O succeeded. zpool status -s shows the SLOW count. With the SERD properties set the disk ends up DEGRADED as in path cksum_degrade; otherwise nothing changes.

### 10.4 `deadman` - Hung I/O (deadman)

Category: Detection. An I/O does not complete at all. Either spa_sync() runs for longer than zfs_deadman_synctime_ms, or a zio_wait() caller waits for longer than zfs_deadman_ziotime_ms. The deadman logs the hung zios and posts deadman ereports; zfs_deadman_failmode decides whether it also forces them to complete.

Alternatives:
- `trigger`: `sync` A txg sync takes too long; `wait` A zio_wait() caller waits too long
- `dmode`: `wait` zfs_deadman_failmode=wait (default): only report; `continue` zfs_deadman_failmode=continue: the hung leaf zio is completed with EINTR

```
 1  E039  spa_sync -> deadman  [trigger: sync]
 2  E040  zio_create -> deadman  [trigger: wait]
 3  E041  deadman -> ereport_post
 4  E043  ereport_post -> ereport_build  "at most zfs_deadman_events_per_second per disk"
 5  E044  ereport_build -> zevent_q
 6  E042  deadman -> zio_taskq  [dmode: continue]
 7  E003  zio_taskq -> st_vdev_io_done  [dmode: continue]  "the hung zio completes with EINTR"
 8  E054  zed_loop -> libzfs_ev
 9  E053  libzfs_ev -> ioc_events
10  E051  ioc_events -> zevent_q
11  E050  zevent_q -> ioc_events
12  E052  ioc_events -> libzfs_ev
13  E055  libzfs_ev -> zed_loop
14  E058  zed_loop -> zedlets  "for example deadman-sync-slot_off.sh, which can power off the slot"
```
Ends: The deadman never faults a disk by itself. With failmode wait the I/O keeps waiting and the check repeats every zfs_deadman_checktime_ms; with continue the EINTR goes through normal error handling; with panic the system panics.

### 10.5 `zed_fault` - Repeated I/O errors: zed faults the disk, a hot spare takes over

Category: Diagnosis. The io SERD engine of a disk fires (ten io ereports within ten minutes by default). After a 15 second grace period for a removal event, the diagnosis engine solves fault.fs.zfs.vdev.io, the retire agent faults the disk through libzfs, and a hot spare is attached as a replacement.

Alternatives:
- `spare`: `yes` The pool has an available hot spare; `no` No spare: the disk stays FAULTED and the vdev above it DEGRADED

```
 1  E054  zed_loop -> libzfs_ev  "another io ereport for the same disk"
 2  E053  libzfs_ev -> ioc_events
 3  E051  ioc_events -> zevent_q
 4  E050  zevent_q -> ioc_events
 5  E052  ioc_events -> libzfs_ev
 6  E055  libzfs_ev -> zed_loop
 7  E057  zed_loop -> agents
 8  E061  agents -> diagnosis
 9  E064  diagnosis -> serd
10  E065  serd -> diagnosis  "the tenth event within 600 s: fired"
11  E067  diagnosis -> fmd_case  "no resource.fs.zfs.removed arrived within 15 s"
12  E070  fmd_case -> agents
13  E062  agents -> retire
14  E071  retire -> libzfs_state  "zpool_vdev_fault()"
15  E085  libzfs_state -> ioc_state
16  E088  ioc_state -> vdev_fault
17  E091  vdev_fault -> vdev_state
18  E049  vdev_state -> sysevent  "statechange to FAULTED"
19  E048  sysevent -> zevent_q
20  E073  retire -> libzfs_attach  [spare: yes]
21  E087  libzfs_attach -> ioc_state  [spare: yes]
22  E090  ioc_state -> spa_attach  [spare: yes]
23  E117  spa_attach -> vdev_state  [spare: yes]
24  E118  spa_attach -> dtl  [spare: yes]
25  E119  spa_attach -> sysevent  [spare: yes]
26  E120  spa_attach -> resilver_start  [spare: yes]
```
Ends: The disk is FAULTED (or DEGRADED if it held the only copy of some data) and no longer receives I/O. With a spare, a spare vdev holds the failed disk and the spare, and a resilver copies everything onto the spare; it continues in the scrub and resilver graph (`zfs-scrub-resilver:resilver`). The spare stays attached until the failed disk is replaced or brought back. A fault requested by zed is not kept when the pool is next imported; the disk is then opened again.

### 10.6 `cksum_degrade` - Repeated checksum errors: zed degrades the disk

Category: Diagnosis. The checksum SERD engine of a disk fires (ten checksum ereports within ten minutes by default, scrub and resilver I/O excluded). The disk is marked DEGRADED, which changes nothing for I/O but tells the administrator, and a hot spare is attached if one is available.

```
 1  E054  zed_loop -> libzfs_ev  "another checksum ereport for the same disk"
 2  E053  libzfs_ev -> ioc_events
 3  E051  ioc_events -> zevent_q
 4  E050  zevent_q -> ioc_events
 5  E052  ioc_events -> libzfs_ev
 6  E055  libzfs_ev -> zed_loop
 7  E057  zed_loop -> agents
 8  E061  agents -> diagnosis
 9  E064  diagnosis -> serd
10  E065  serd -> diagnosis  "the tenth event within 600 s: fired"
11  E066  diagnosis -> fmd_case  "fault.fs.zfs.vdev.checksum, solved at once"
12  E070  fmd_case -> agents
13  E062  agents -> retire
14  E071  retire -> libzfs_state  "zpool_vdev_degrade()"
15  E085  libzfs_state -> ioc_state
16  E088  ioc_state -> vdev_fault
17  E092  vdev_fault -> vdev_state
18  E049  vdev_state -> sysevent  "statechange to DEGRADED"
19  E048  sysevent -> zevent_q
20  E073  retire -> libzfs_attach  "only when a spare is available"
21  E087  libzfs_attach -> ioc_state
22  E090  ioc_state -> spa_attach
23  E120  spa_attach -> resilver_start
```
Ends: The disk is DEGRADED but still read and written. If a spare was available it is attached and resilvered as in path zed_fault.

### 10.7 `kernel_fault` - The kernel faults an unreachable disk (probe failure)

Category: Diagnosis. An I/O fails on a disk that still looks present, the probe of its label areas fails too, and the kernel itself marks the disk FAULTED from the SPA async thread. zed's retire agent then sees the state change and attaches a spare.

```
 1  E001  dev_normal -> vdev_intr  "the disk stops answering correctly"
 2  E002  vdev_intr -> zio_taskq
 3  E003  zio_taskq -> st_vdev_io_done
 4  E006  st_vdev_io_done -> probe  "the label pad reads or writes fail"
 5  E032  probe -> ereport_post
 6  E043  ereport_post -> ereport_build
 7  E044  ereport_build -> zevent_q
 8  E033  probe -> async
 9  E034  async -> vdev_state  "FAULTED, because the other mirror side still has the data"
10  E049  vdev_state -> sysevent
11  E048  sysevent -> zevent_q
12  E054  zed_loop -> libzfs_ev
13  E053  libzfs_ev -> ioc_events
14  E051  ioc_events -> zevent_q
15  E050  zevent_q -> ioc_events
16  E052  ioc_events -> libzfs_ev
17  E055  libzfs_ev -> zed_loop
18  E057  zed_loop -> agents
19  E062  agents -> retire  "statechange to FAULTED"
20  E073  retire -> libzfs_attach  "spare_on_remove: try the spares"
21  E087  libzfs_attach -> ioc_state
22  E090  ioc_state -> spa_attach
```
Ends: The disk is FAULTED without any SERD diagnosis. If a spare was attached, the resilver starts as in path zed_fault. When the only copy is affected the pool suspends instead (path suspend_clear, cause dead_disk).

### 10.8 `device_removed` - Device removed and returning (DTL, resilver)

Category: Device state. A disk of a mirror disappears. It is marked REMOVED, earlier errors are forgiven, writes skip it and record their txgs in its DTL. When the disk is plugged back in, zed onlines it and a resilver copies exactly the missed txgs. A different blank disk in the same slot is used as a replacement when autoreplace is on.

Alternatives:
- `detect`: `kernel` Linux sees an EIO and the disk gone (vdev_disk_io_done); `udev` zed sees the udev remove event first
- `back`: `same` The same disk comes back; `new` A new disk in the same slot, pool property autoreplace=on

```
 1  E001  dev_normal -> vdev_intr  [detect: kernel]  "an I/O fails with EIO: the disk was pulled"
 2  E002  vdev_intr -> zio_taskq  [detect: kernel]
 3  E003  zio_taskq -> st_vdev_io_done  [detect: kernel]
 4  E007  st_vdev_io_done -> vdev_leaf  [detect: kernel]
 5  E008  vdev_leaf -> async  [detect: kernel]
 6  E059  dev_normal -> udev  [detect: udev]  "the udev remove event"
 7  E060  udev -> agents  [detect: udev]
 8  E062  agents -> retire  [detect: udev]
 9  E072  retire -> libzfs_state  [detect: udev]
10  E085  libzfs_state -> ioc_state  [detect: udev]
11  E089  ioc_state -> vdev_online  [detect: udev]  "VDEV_STATE_REMOVED"
12  E094  vdev_online -> probe  [detect: udev]
13  E095  vdev_online -> async  [detect: udev]
14  E036  async -> vdev_state  "REMOVED; the mirror above becomes DEGRADED"
15  E049  vdev_state -> sysevent
16  E037  async -> sysevent
17  E048  sysevent -> zevent_q
18  E054  zed_loop -> libzfs_ev
19  E053  libzfs_ev -> ioc_events
20  E051  ioc_events -> zevent_q
21  E050  zevent_q -> ioc_events
22  E052  ioc_events -> libzfs_ev
23  E055  libzfs_ev -> zed_loop
24  E057  zed_loop -> agents
25  E061  agents -> diagnosis
26  E069  diagnosis -> serd  "errors just before the removal are blamed on it"
27  E004  st_vdev_io_start -> zio_taskq  "txg sync writes to the mirror: the missing side fails with ENXIO at once"
28  E003  zio_taskq -> st_vdev_io_done
29  E005  st_vdev_io_done -> st_vdev_io_assess
30  E010  st_vdev_io_assess -> st_done
31  E023  st_done -> vdev_stat  "no READ or WRITE count and no ereport: the disk is dead"
32  E031  vdev_stat -> dtl  "the txg is added to the disk's DTL_MISSING"
33  E112  spa_sync -> dtl
34  E059  dev_normal -> udev  "a disk is plugged into the slot"
35  E060  udev -> agents
36  E063  agents -> slm
37  E074  slm -> libzfs_state
38  E085  libzfs_state -> ioc_state
39  E089  ioc_state -> vdev_online  "VDEV_STATE_ONLINE"
40  E093  vdev_online -> vdev_open  [back: same]
41  E096  vdev_open -> vdev_state  [back: same]  "HEALTHY again"
42  E097  vdev_open -> resilver_start  [back: same]
43  E098  dtl -> resilver_start  [back: same]
44  E099  resilver_start -> async  [back: same]
45  E038  async -> resilver_start  [back: same]
46  E075  slm -> libzfs_attach  [back: new]  "the online failed: not the same disk"
47  E087  libzfs_attach -> ioc_state  [back: new]
48  E090  ioc_state -> spa_attach  [back: new]
49  E118  spa_attach -> dtl  [back: new]
50  E120  spa_attach -> resilver_start  [back: new]
```
Ends: A resilver starts that copies the txgs in the DTL to the returned disk (or everything to the new one); it continues in the scrub and resilver graph (`zfs-scrub-resilver:resilver`). In both detection cases the retire agent also attaches a spare when one is available (spare_on_remove); when the original disk is onlined with ZFS_ONLINE_UNSPARE, that spare is detached again after the resilver.

### 10.9 `suspend_clear` - Pool suspend and zpool clear

Category: Pool failure. Some I/O cannot be completed and must not be dropped, so the pool suspends: new transactions wait (failmode=wait) or fail with EIO (failmode=continue), or the system panics (failmode=panic). After the administrator restores the devices, zpool clear clears the errors, reopens the devices and re-executes the held I/O.

Alternatives:
- `cause`: `labels` spa_sync() cannot write the vdev labels; `missing_read` A read finds every copy on missing disks; `dead_disk` The kernel faults the disk that holds the only copy

```
 1  E109  spa_sync -> uberblock  [cause: labels]
 2  E110  uberblock -> suspend  [cause: labels]
 3  E005  st_vdev_io_done -> st_vdev_io_assess  [cause: missing_read]  "the logical read failed: every child returned ENXIO"
 4  E011  st_vdev_io_assess -> zio_taskq  [cause: missing_read]
 5  E012  zio_taskq -> st_vdev_io_start  [cause: missing_read]
 6  E004  st_vdev_io_start -> zio_taskq  [cause: missing_read]  "every child fails with ENXIO again"
 7  E003  zio_taskq -> st_vdev_io_done  [cause: missing_read]
 8  E005  st_vdev_io_done -> st_vdev_io_assess  [cause: missing_read]
 9  E010  st_vdev_io_assess -> st_done  [cause: missing_read]
10  E029  st_done -> suspend  [cause: missing_read]  "ENXIO on a read, failmode is not continue"
11  E001  dev_normal -> vdev_intr  [cause: dead_disk]  "the disk of a single-disk top-level vdev stops working"
12  E002  vdev_intr -> zio_taskq  [cause: dead_disk]
13  E003  zio_taskq -> st_vdev_io_done  [cause: dead_disk]
14  E006  st_vdev_io_done -> probe  [cause: dead_disk]
15  E033  probe -> async  [cause: dead_disk]
16  E034  async -> vdev_state  [cause: dead_disk]  "DEGRADED, not FAULTED: it holds the only copy"
17  E035  async -> suspend  [cause: dead_disk]
18  E005  st_vdev_io_done -> st_vdev_io_assess  [cause: dead_disk]  "meanwhile a txg write to that disk failed"
19  E010  st_vdev_io_assess -> st_done  [cause: dead_disk]
20  E030  st_done -> zio_taskq  [cause: dead_disk]  "the write tree is re-executed, and fails again"
21  E107  suspend -> ereport_post
22  E043  ereport_post -> ereport_build
23  E044  ereport_build -> zevent_q
24  E108  suspend -> dmu_tx  "failmode=wait: writers block; continue: EIO"
25  E054  zed_loop -> libzfs_ev
26  E053  libzfs_ev -> ioc_events
27  E051  ioc_events -> zevent_q
28  E050  zevent_q -> ioc_events
29  E052  ioc_events -> libzfs_ev
30  E055  libzfs_ev -> zed_loop
31  E057  zed_loop -> agents
32  E061  agents -> diagnosis
33  E068  diagnosis -> fmd_case
34  E084  zpool_cli -> libzfs_state  "the administrator restores the disks and runs zpool clear"
35  E086  libzfs_state -> ioc_clear
36  E100  ioc_clear -> vdev_clear
37  E101  vdev_clear -> vdev_stat
38  E102  vdev_clear -> vdev_open
39  E096  vdev_open -> vdev_state
40  E103  vdev_clear -> sysevent
41  E104  vdev_clear -> ereport_post
42  E105  ioc_clear -> suspend
43  E106  suspend -> zio_create
```
Ends: The pool runs again and every held zio has been re-executed from the start. If a device is still unusable the I/O fails again and the pool suspends again. With failmode=panic the system panicked in zio_suspend() and none of the later steps happen.

### 10.10 `permanent_error` - Permanent error recorded and listed

Category: Error log. A block cannot be read from any copy. The logical zio fails, its bookmark goes into the error log, which is written to the pool in the next txg, and zpool status -v lists the affected file. The entry goes away only when a later scrub completes without finding the error again.

```
 1  E001  dev_normal -> vdev_intr  "the last copy of a block returns wrong data"
 2  E002  vdev_intr -> zio_taskq
 3  E003  zio_taskq -> st_vdev_io_done
 4  E005  st_vdev_io_done -> st_vdev_io_assess
 5  E009  st_vdev_io_assess -> st_cksum_verify
 6  E013  st_cksum_verify -> vdev_stat
 7  E014  st_cksum_verify -> cksum_report
 8  E015  st_cksum_verify -> st_done  "no other copy is left: the logical read fails with ECKSUM"
 9  E028  st_done -> cksum_report  "finished without good data"
10  E047  cksum_report -> zevent_q
11  E027  st_done -> errlog
12  E026  st_done -> ereport_post
13  E043  ereport_post -> ereport_build
14  E044  ereport_build -> zevent_q
15  E054  zed_loop -> libzfs_ev
16  E053  libzfs_ev -> ioc_events
17  E051  ioc_events -> zevent_q
18  E050  zevent_q -> ioc_events
19  E052  ioc_events -> libzfs_ev
20  E055  libzfs_ev -> zed_loop
21  E058  zed_loop -> zedlets  "data-notify.sh mails the administrator if configured"
22  E111  spa_sync -> errlog  "the entry is written in the next txg"
23  E078  zpool_cli -> libzfs_status  "zpool status -v"
24  E079  libzfs_status -> ioc_status
25  E081  ioc_status -> errlog
26  E082  ioc_status -> libzfs_status
27  E083  libzfs_status -> zpool_cli
28  E113  spa_sync -> scan_done  "later: the file was restored or deleted, and a scrub completes"
29  E114  scan_done -> errlog
30  E111  spa_sync -> errlog  "the next sync deletes the old log; the scrub's log becomes the last log"
31  E115  scan_done -> ereport_post
32  E116  scan_done -> sysevent
33  E048  sysevent -> zevent_q
```
Ends: The error stays listed across zpool clear and reboots until a scrub or resilver ends without having seen it again. If the damaged block is still referenced, the scrub reads it, logs it again, and it stays listed.

### 10.11 `status_events` - Where zpool status and zpool events get their data

Category: Reporting. zpool status reads the pool configuration with the per-vdev counters and the error count; zpool events reads the zevent queue through its own /dev/zfs cursor, exactly as zed does.

Alternatives:
- `cmd`: `status` zpool status; `events` zpool events

```
 1  E121  admin -> zpool_cli
 2  E078  zpool_cli -> libzfs_status  [cmd: status]
 3  E079  libzfs_status -> ioc_status  [cmd: status]
 4  E080  ioc_status -> vdev_stat  [cmd: status]
 5  E081  ioc_status -> errlog  [cmd: status]  "without -v only the approximate count"
 6  E082  ioc_status -> libzfs_status  [cmd: status]
 7  E083  libzfs_status -> zpool_cli  [cmd: status]
 8  E076  zpool_cli -> libzfs_ev  [cmd: events]
 9  E053  libzfs_ev -> ioc_events  [cmd: events]
10  E051  ioc_events -> zevent_q  [cmd: events]
11  E050  zevent_q -> ioc_events  [cmd: events]
12  E052  ioc_events -> libzfs_ev  [cmd: events]
13  E077  libzfs_ev -> zpool_cli  [cmd: events]
```
Ends: zpool status shows READ, WRITE and CKSUM (and SLOW with -s) per vdev from in-memory counters that start at zero at import and are reset by zpool clear; zpool events shows the events still in the queue (at most zfs_zevent_len_max).

## 11. Accuracy rules and known simplifications

Rules: verify against the pinned commit; OS-specific pieces use Linux names (vdev_disk.c, udev), and zed as shipped in `cmd/zed`.

Simplifications made on purpose. State these in the page's About overlay so nobody mistakes the diagram for the whole truth:

1. The six zed read steps (zed_loop to libzfs_ev to the ioctl to the queue and back) are drawn for every event, although zed reads events continuously and processes them strictly one after the other.
2. The mirror and RAIDZ child zios go straight back to VDEV_IO_START in this graph; the I/O graph draws them through zio_vdev_child_io(). The logical zio, the top-level vdev zio and the leaf zios all pass through the same stage nodes.
3. Counters, ereports and DTL updates happen in the order of the code in zio_done(), but a path shows them in the order that reads best; several of them happen for each of the zios in a tree.
4. The SERD engines, cases and fault lists are zed's own small re-implementation of the illumos fault manager; there is no separate fmd process. Case state is not kept across zed restarts in the way illumos fmd keeps it.
5. Only the main event classes are named. Others (vdev.* open failures, config cache write failures, authentication, Direct I/O verify, log replay, pool load failures) follow the same ereport path.
6. Spare selection, dRAID spares and fault domains, multipath disks and partition handling in zfs_mod are reduced to one wire each.
7. The resilver itself, its DTL reassessment and the detach of a finished replacement or spare belong to the scrub and resilver graph.
8. MMP (multihost) suspends, which use the same suspend node, are not drawn.

## 12. Build order

See `../zfs-io-flow-diagram-spec.md` section 12 and `zfs-viewer-suite-spec.md`.

## 13. Acceptance checklist

- Counts: 54 nodes, 121 wires, 11 paths, 307 path steps, 7 groups, 7 wire types, 146 functions in the index, 256 wire references (Appendix C), 22 tunable and property references (Appendix D).
- Activating path `zed_fault` with the default alternatives highlights 26 distinct wires and plays 26 steps; `cksum_repair` highlights 26 and plays 27; `device_removed` highlights 36 and plays 37. Switching `cksum_repair` to `layout: raidz` swaps the CHECKSUM_VERIFY and mirror wires for the RAIDZ wires.
- Node `st_done` lists 2 incoming and 9 outgoing wires. Node `zevent_q` lists 5 incoming and 1 outgoing wires.
- Searching `zfs_ereport_post` finds node `ereport_post`; searching `failmode` finds node `suspend`; searching `vdev_dtl_dirty` finds node `dtl`.
- On the suite pages, every node whose role starts with "Shared with the I/O flow graph." shows "Also in: ZFS I/O Flow".
- The About overlay contains the seven mental-model points and the eight simplifications.

## Appendix A. Function index

The functions named in section 8, with file and line of their definition at commit `c913da8615`. Use these for source links.

```
_bump_event_queue_length  cmd/zed/zed_event.c:114
_zed_exec_fork_child  cmd/zed/zed_exec.c:112
annotate_ecksum  module/zfs/zfs_fm.c:916
dmu_tx_assign  module/zfs/dmu_tx.c:1239
dmu_tx_try_assign  module/zfs/dmu_tx.c:1055
dmu_tx_wait  module/zfs/dmu_tx.c:1342
dsl_scan_assess_vdev  module/zfs/dsl_scan.c:5493
dsl_scan_done  module/zfs/dsl_scan.c:1199
dsl_scan_restart_resilver  module/zfs/dsl_scan.c:1560
fm_ena_generate  module/zfs/fm.c:1218
fm_ereport_set  module/zfs/fm.c:751
fm_payload_set  module/zfs/fm.c:715
fmd_case_add_suspect  cmd/zed/agents/fmd_api.c:371
fmd_case_open  cmd/zed/agents/fmd_api.c:229
fmd_case_solve  cmd/zed/agents/fmd_api.c:254
fmd_fault_mkcode  cmd/zed/agents/fmd_api.c:342
fmd_serd_create  cmd/zed/agents/fmd_api.c:459
fmd_serd_eng_record  cmd/zed/agents/fmd_serd.c:229
fmd_serd_record  cmd/zed/agents/fmd_api.c:518
fmd_serd_reset  cmd/zed/agents/fmd_api.c:504
print_error_log  cmd/zpool/zpool_main.c:10788
print_status_config  cmd/zpool/zpool_main.c:2882
raidz_checksum_verify  module/zfs/vdev_raidz.c:2956
replace_with_spare  cmd/zed/agents/zfs_retire.c:414
spa_approx_errlog_size  module/zfs/spa_errlog.c:782
spa_async_fault_vdev  module/zfs/spa.c:10199
spa_async_remove  module/zfs/spa.c:10171
spa_async_request  module/zfs/spa.c:10506
spa_async_thread  module/zfs/spa.c:10239
spa_deadman  module/zfs/spa_misc.c:780
spa_errlog_rotate  module/zfs/spa_errlog.c:1185
spa_errlog_sync  module/zfs/spa_errlog.c:1316
spa_event_notify  module/zfs/spa.c:12303
spa_get_errlog  module/zfs/spa_errlog.c:1141
spa_get_stats  module/zfs/spa.c:7029
spa_log_error  module/zfs/spa_errlog.c:174
spa_spare_activate  module/zfs/spa_misc.c:1279
spa_suspended  module/zfs/spa_misc.c:2165
spa_sync  module/zfs/spa.c:11405
spa_sync_iterate_to_convergence  module/zfs/spa.c:11192
spa_sync_rewrite_vdev_config  module/zfs/spa.c:11355
spa_taskq_dispatch  module/zfs/spa.c:1691
spa_vdev_attach  module/zfs/spa.c:8545
status_callback  cmd/zpool/zpool_main.c:11484
sync_error_list  module/zfs/spa_errlog.c:1220
vbio_completion  module/os/linux/zfs/vdev_disk.c:881
vdev_clear  module/zfs/vdev.c:4971
vdev_deadman  module/zfs/vdev.c:6082
vdev_degrade  module/zfs/vdev.c:4675
vdev_disk_io_done  module/os/linux/zfs/vdev_disk.c:1340
vdev_dtl_contains  module/zfs/vdev.c:3247
vdev_dtl_dirty  module/zfs/vdev.c:3229
vdev_dtl_reassess  module/zfs/vdev.c:3630
vdev_dtl_required  module/zfs/vdev.c:3875
vdev_dtl_sync  module/zfs/vdev.c:3791
vdev_fault  module/zfs/vdev.c:4587
vdev_get_stats_ex  module/zfs/vdev.c:5233
vdev_mirror_child_select  module/zfs/vdev_mirror.c:524
vdev_mirror_io_done  module/zfs/vdev_mirror.c:734
vdev_online  module/zfs/vdev.c:4740
vdev_open  module/zfs/vdev.c:2216
vdev_probe  module/zfs/vdev.c:1942
vdev_probe_done  module/zfs/vdev.c:1863
vdev_propagate_state  module/zfs/vdev.c:5762
vdev_raidz_checksum_error  module/zfs/vdev_raidz.c:2930
vdev_raidz_io_done  module/zfs/vdev_raidz.c:4044
vdev_remove_wanted  module/zfs/vdev.c:4702
vdev_reopen  module/zfs/vdev.c:3001
vdev_resilver_needed  module/zfs/vdev.c:3911
vdev_set_state  module/zfs/vdev.c:5827
vdev_stat_update  module/zfs/vdev.c:5348
zed_event_init  cmd/zed/zed_event.c:52
zed_event_seek  cmd/zed/zed_event.c:173
zed_event_service  cmd/zed/zed_event.c:953
zed_exec_process  cmd/zed/zed_exec.c:368
zed_udev_event  cmd/zed/zed_disk_event.c:61
zed_udev_monitor  cmd/zed/zed_disk_event.c:179
zfs_agent_consumer_thread  cmd/zed/agents/zfs_agents.c:357
zfs_agent_dispatch  cmd/zed/agents/zfs_agents.c:308
zfs_agent_post_event  cmd/zed/agents/zfs_agents.c:185
zfs_case_solve  cmd/zed/agents/zfs_diagnosis.c:456
zfs_deliver_add  cmd/zed/agents/zfs_mod.c:906
zfs_deliver_check  cmd/zed/agents/zfs_mod.c:965
zfs_ereport_clear  module/zfs/zfs_fm.c:289
zfs_ereport_finish_checksum  module/zfs/zfs_fm.c:1252
zfs_ereport_is_duplicate  module/zfs/zfs_fm.c:331
zfs_ereport_is_valid  module/zfs/zfs_fm.c:1076
zfs_ereport_post  module/zfs/zfs_fm.c:1157
zfs_ereport_post_checksum  module/zfs/zfs_fm.c:1304
zfs_ereport_start  module/zfs/zfs_fm.c:464
zfs_ereport_start_checksum  module/zfs/zfs_fm.c:1200
zfs_event_create  module/zfs/zfs_fm.c:1350
zfs_fm_recv  cmd/zed/agents/zfs_diagnosis.c:554
zfs_fm_serd_record  cmd/zed/agents/zfs_diagnosis.c:531
zfs_fm_timeout  cmd/zed/agents/zfs_diagnosis.c:1058
zfs_ioc_clear  module/zfs/zfs_ioctl.c:6572
zfs_ioc_error_log  module/zfs/zfs_ioctl.c:6555
zfs_ioc_events_clear  module/zfs/zfs_ioctl.c:7224
zfs_ioc_events_next  module/zfs/zfs_ioctl.c:7182
zfs_ioc_events_seek  module/zfs/zfs_ioctl.c:7240
zfs_ioc_pool_stats  module/zfs/zfs_ioctl.c:1869
zfs_ioc_vdev_attach  module/zfs/zfs_ioctl.c:2391
zfs_ioc_vdev_set_state  module/zfs/zfs_ioctl.c:2344
zfs_is_ratelimiting_event  module/zfs/zfs_fm.c:437
zfs_other_serd_cases  cmd/zed/agents/zfs_diagnosis.c:175
zfs_post_remove  module/zfs/zfs_fm.c:1431
zfs_post_state_change  module/zfs/zfs_fm.c:1468
zfs_process_add  cmd/zed/agents/zfs_mod.c:187
zfs_retire_recv  cmd/zed/agents/zfs_retire.c:567
zfs_slm_deliver_event  cmd/zed/agents/zfs_mod.c:1298
zfs_slm_event  cmd/zed/agents/zfs_mod.c:1414
zfs_vdev_repair  cmd/zed/agents/zfs_retire.c:529
zfs_zevent_drain  module/zfs/fm.c:134
zfs_zevent_insert  module/zfs/fm.c:172
zfs_zevent_next  module/zfs/fm.c:303
zfs_zevent_post  module/zfs/fm.c:191
zfs_zevent_wait  module/zfs/fm.c:360
zio_checksum_error  module/zfs/zio_checksum.c:554
zio_checksum_verify  module/zfs/zio.c:5747
zio_deadman  module/zfs/zio.c:2622
zio_deadman_impl  module/zfs/zio.c:2564
zio_done  module/zfs/zio.c:6065
zio_interrupt  module/zfs/zio.c:2496
zio_reexecute  module/zfs/zio.c:2930
zio_resume  module/zfs/zio.c:3060
zio_resume_wait  module/zfs/zio.c:3092
zio_root  module/zfs/zio.c:1093
zio_suspend  module/zfs/zio.c:3016
zio_taskq_dispatch  module/zfs/zio.c:2258
zio_vdev_io_assess  module/zfs/zio.c:5436
zio_vdev_io_done  module/zfs/zio.c:5320
zio_vdev_io_start  module/zfs/zio.c:5135
zio_wait  module/zfs/zio.c:2841
zpool_clear  lib/libzfs/libzfs_pool.c:4655
zpool_do_clear  cmd/zpool/zpool_main.c:8286
zpool_do_events_next  cmd/zpool/zpool_main.c:12944
zpool_do_status  cmd/zpool/zpool_main.c:11681
zpool_events_next  lib/libzfs/libzfs_pool.c:5462
zpool_get_errlog  lib/libzfs/libzfs_pool.c:5197
zpool_obj_to_path  lib/libzfs/libzfs_pool.c:5688
zpool_refresh_stats  lib/libzfs/libzfs_config.c:208
zpool_vdev_attach  lib/libzfs/libzfs_pool.c:3920
zpool_vdev_degrade  lib/libzfs/libzfs_pool.c:3871
zpool_vdev_fault  lib/libzfs/libzfs_pool.c:3767
zpool_vdev_online  lib/libzfs/libzfs_pool.c:3594
zpool_vdev_remove_wanted  lib/libzfs/libzfs_pool.c:3737
```

## Appendix C. Wire source references

References for the wires, at commit `c913da8615`. Each line is `<wire>  <file>:<line>  <symbol>`, and the symbol appears verbatim on that source line. A wire's references are listed in the order of the calls in its label. Where a wire is a callback or a decision, the reference is the line where the hand-over happens.

```
E001  module/os/linux/zfs/vdev_disk.c:881  vbio_completion
E001  module/os/linux/zfs/vdev_disk.c:889  bi_status_to_errno
E002  module/os/linux/zfs/vdev_disk.c:910  zio_delay_interrupt
E002  module/zfs/zio.c:2536  zio_interrupt
E003  module/zfs/zio.c:2500  ZIO_TASKQ_INTERRUPT
E004  module/zfs/zio.c:5292  vdev_accessible
E004  module/zfs/zio.c:5293  ENXIO
E004  module/zfs/zio.c:5294  zio_interrupt
E005  module/zfs/zio.c:5320  zio_vdev_io_done
E005  module/zfs/zio.c:5436  zio_vdev_io_assess
E006  module/zfs/zio.c:5359  unexpected_error
E006  module/zfs/zio.c:5375  vdev_probe
E007  module/zfs/zio.c:5372  vdev_op_io_done
E007  module/os/linux/zfs/vdev_disk.c:1340  vdev_disk_io_done
E008  module/os/linux/zfs/vdev_disk.c:1373  zfs_check_disk_status
E008  module/os/linux/zfs/vdev_disk.c:1375  vdev_remove_wanted
E008  module/os/linux/zfs/vdev_disk.c:1376  SPA_ASYNC_REMOVE
E009  module/zfs/zio.c:5747  zio_checksum_verify
E010  module/zfs/zio.c:5494  vdev_accessible
E010  module/zfs/zio.c:5522  ZIO_INTERLOCK_PIPELINE
E011  module/zfs/zio.c:5477  io_error
E011  module/zfs/zio.c:5482  ZIO_FLAG_IO_RETRY
E012  module/zfs/zio.c:5483  ZIO_STAGE_VDEV_IO_START
E012  module/zfs/zio.c:5485  zio_requeue_io_start_cut_in_line
E013  module/zfs/zio.c:5768  zio_checksum_error
E013  module/zfs/zio.c:5792  vs_checksum_errors
E014  module/zfs/zio.c:5794  zfs_ereport_start_checksum
E014  module/zfs/zfs_fm.c:1221  zio_vsd_default_cksum_report
E015  module/zfs/zio.c:5769  io_error
E016  module/zfs/zio.c:6456  zio_notify_parent
E017  module/zfs/vdev_mirror.c:734  vdev_mirror_io_done
E017  module/zfs/vdev_mirror.c:814  vdev_mirror_child_select
E018  module/zfs/vdev_mirror.c:818  zio_vdev_child_io
E018  module/zfs/vdev_mirror.c:953  ZIO_FLAG_IO_REPAIR
E019  module/zfs/vdev_raidz.c:4044  vdev_raidz_io_done
E019  module/zfs/vdev_raidz.c:4101  raidz_checksum_verify
E020  module/zfs/vdev_raidz.c:2930  vdev_raidz_checksum_error
E020  module/zfs/vdev_raidz.c:2943  vs_checksum_errors
E021  module/zfs/vdev_raidz.c:2945  zfs_ereport_post_checksum
E022  module/zfs/vdev_raidz.c:3400  zio_vdev_child_io
E022  module/zfs/vdev_raidz.c:3405  ZIO_FLAG_IO_REPAIR
E023  module/zfs/zio.c:6180  vdev_stat_update
E023  module/zfs/zio.c:6201  vs_slow_ios
E023  module/zfs/zio.c:6229  vs_read_errors
E023  module/zfs/zio.c:6231  vs_write_errors
E024  module/zfs/zio.c:6224  FM_EREPORT_ZFS_IO
E025  module/zfs/zio.c:6187  zio_slow_io_ms
E025  module/zfs/zio.c:6204  vdev_slow_io_events
E025  module/zfs/zio.c:6206  FM_EREPORT_ZFS_DELAY
E026  module/zfs/zio.c:6246  FM_EREPORT_ZFS_DATA
E027  module/zfs/zio.c:6244  spa_log_error
E027  module/zfs/spa_errlog.c:195  spa_errlist_scrub
E027  module/zfs/spa_errlog.c:197  spa_errlist_last
E028  module/zfs/zio.c:6140  zcr_finish
E028  module/zfs/zio.c:5419  zfs_ereport_finish_checksum
E028  module/zfs/zio.c:6411  zcr_finish
E029  module/zfs/zio.c:6274  ZIO_FAILURE_MODE_CONTINUE
E029  module/zfs/zio.c:6279  ZIO_POST_SUSPEND
E029  module/zfs/zio.c:6385  zio_suspend
E030  module/zfs/zio.c:6264  ZIO_POST_REEXECUTE
E030  module/zfs/zio.c:6392  spa_taskq_dispatch
E030  module/zfs/zio.c:2954  indefinitely
E031  module/zfs/vdev.c:5503  ZIO_FLAG_IO_RETRY
E031  module/zfs/vdev.c:5561  DTL_PARTIAL
E031  module/zfs/vdev.c:5565  DTL_MISSING
E031  module/zfs/vdev.c:5562  VDD_DTL
E032  module/zfs/vdev.c:1901  FM_EREPORT_ZFS_PROBE_FAILURE
E033  module/zfs/vdev.c:1915  vdev_fault_wanted
E033  module/zfs/vdev.c:1916  SPA_ASYNC_FAULT_VDEV
E034  module/zfs/spa.c:10215  vdev_set_state
E034  module/zfs/spa.c:10210  vdev_dtl_required
E035  module/zfs/spa.c:10323  zio_suspend
E036  module/zfs/spa.c:10176  VDEV_STATE_REMOVED
E036  module/zfs/spa.c:10184  vs_read_errors
E037  module/zfs/spa.c:10191  zfs_post_remove
E037  module/zfs/zfs_fm.c:1444  FM_RESOURCE_REMOVED
E038  module/zfs/spa.c:10342  dsl_scan_restart_resilver
E039  module/zfs/spa.c:11473  spa_deadman
E039  module/zfs/spa_misc.c:795  spa_deadman
E040  module/zfs/zio.c:2877  zio_deadman
E041  module/zfs/vdev.c:6110  zio_deadman
E041  module/zfs/zio.c:2596  FM_EREPORT_ZFS_DEADMAN
E042  module/zfs/zio.c:2605  EINTR
E042  module/zfs/zio.c:2606  zio_interrupt
E042  module/zfs/zio.c:2642  fm_panic
E043  module/zfs/zfs_fm.c:1165  zfs_ereport_is_valid
E043  module/zfs/zfs_fm.c:1168  zfs_ereport_is_duplicate
E043  module/zfs/zfs_fm.c:1171  zfs_is_ratelimiting_event
E043  module/zfs/zfs_fm.c:1174  zfs_ereport_start
E044  module/zfs/zfs_fm.c:513  fm_ereport_set
E044  module/zfs/zfs_fm.c:1182  zfs_zevent_post
E044  module/zfs/fm.c:175  list_insert_head
E044  module/zfs/fm.c:178  zfs_zevent_drain
E045  module/zfs/zfs_fm.c:1206  zfs_ereport_is_valid
E045  module/zfs/zfs_fm.c:1209  zfs_ereport_is_duplicate
E045  module/zfs/zfs_fm.c:1213  zfs_is_ratelimiting_event
E046  module/zfs/zfs_fm.c:1235  zfs_ereport_start
E046  module/zfs/zfs_fm.c:1246  io_cksum_report
E046  module/zfs/zfs_fm.c:1324  zfs_ereport_start
E047  module/zfs/zfs_fm.c:1258  annotate_ecksum
E047  module/zfs/zfs_fm.c:1261  zfs_zevent_post
E047  module/zfs/zfs_fm.c:1333  zfs_zevent_post
E048  module/zfs/zfs_fm.c:1418  zfs_zevent_post
E048  module/zfs/spa.c:12287  zfs_zevent_post
E049  module/zfs/vdev.c:5964  zfs_post_state_change
E049  module/zfs/zfs_fm.c:1493  FM_RESOURCE_STATECHANGE
E050  module/zfs/fm.c:342  nvlist_dup
E050  module/zfs/fm.c:347  ratelimit_dropped
E051  module/zfs/zfs_ioctl.c:7195  zfs_zevent_next
E051  module/zfs/zfs_ioctl.c:7209  zfs_zevent_wait
E051  module/zfs/fm.c:245  cv_broadcast
E052  module/zfs/zfs_ioctl.c:7199  put_nvlist
E052  module/zfs/zfs_ioctl.c:7198  zc_cookie
E053  lib/libzfs/libzfs_pool.c:5478  ZFS_IOC_EVENTS_NEXT
E054  cmd/zed/zed_event.c:972  zpool_events_next
E055  lib/libzfs/libzfs_pool.c:5501  zcmd_read_dst_nvlist
E055  lib/libzfs/libzfs_pool.c:5505  zc_cookie
E056  cmd/zed/zed_event.c:980  _bump_event_queue_length
E056  cmd/zed/zed_event.c:120  zfs_zevent_len_max
E057  cmd/zed/zed_event.c:1008  zfs_agent_post_event
E057  cmd/zed/agents/zfs_agents.c:300  list_insert_tail
E058  cmd/zed/zed_event.c:1029  zed_exec_process
E058  cmd/zed/zed_exec.c:413  strncmp
E058  cmd/zed/zed_exec.c:424  _zed_exec_fork_child
E059  cmd/zed/zed_disk_event.c:199  udev_monitor_receive_device
E060  cmd/zed/zed_disk_event.c:411  zed_udev_event
E060  cmd/zed/zed_disk_event.c:88  zfs_agent_post_event
E060  cmd/zed/zed_disk_event.c:321  EC_DEV_ADD
E060  cmd/zed/zed_disk_event.c:324  EC_DEV_REMOVE
E060  cmd/zed/agents/zfs_agents.c:224  resource.fs.zfs.removed
E061  cmd/zed/agents/zfs_agents.c:320  zfs-diagnosis
E062  cmd/zed/agents/zfs_agents.c:335  zfs-retire
E063  cmd/zed/agents/zfs_agents.c:346  zfs_slm_event
E063  cmd/zed/agents/zfs_mod.c:1333  zfs_deliver_add
E063  cmd/zed/agents/zfs_mod.c:1331  zfs_deliver_check
E064  cmd/zed/agents/zfs_diagnosis.c:919  fmd_serd_create
E064  cmd/zed/agents/zfs_diagnosis.c:910  DEFAULT_IO_N
E064  cmd/zed/agents/zfs_diagnosis.c:991  DEFAULT_CHECKSUM_N
E064  cmd/zed/agents/zfs_diagnosis.c:945  fmd_serd_create
E064  cmd/zed/agents/zfs_diagnosis.c:924  zfs_fm_serd_record
E064  cmd/zed/agents/zfs_diagnosis.c:534  fmd_serd_record
E065  cmd/zed/agents/fmd_api.c:528  fmd_serd_eng_record
E065  cmd/zed/agents/fmd_serd.c:268  fmd_event_delta
E065  cmd/zed/agents/fmd_serd.c:269  FMD_SERD_FIRED
E065  cmd/zed/agents/zfs_diagnosis.c:537  zfs_other_serd_cases
E066  cmd/zed/agents/zfs_diagnosis.c:1011  fault.fs.zfs.vdev.checksum
E066  cmd/zed/agents/zfs_diagnosis.c:956  fault.fs.zfs.vdev.slow_io
E067  cmd/zed/agents/zfs_diagnosis.c:1043  fmd_timer_install
E067  cmd/zed/agents/zfs_diagnosis.c:114  zfs_remove_timeout
E067  cmd/zed/agents/zfs_diagnosis.c:1063  fault.fs.zfs.vdev.io
E068  cmd/zed/agents/zfs_diagnosis.c:1025  fault.fs.zfs.io_failure_wait
E068  cmd/zed/agents/zfs_diagnosis.c:1021  fault.fs.zfs.io_failure_continue
E069  cmd/zed/agents/zfs_diagnosis.c:802  fmd_serd_reset
E070  cmd/zed/agents/fmd_api.c:374  fmd_fault_mkcode
E070  cmd/zed/agents/fmd_api.c:401  zfs_agent_post_event
E071  cmd/zed/agents/zfs_retire.c:824  zpool_vdev_fault
E071  cmd/zed/agents/zfs_retire.c:826  zpool_vdev_degrade
E072  cmd/zed/agents/zfs_retire.c:676  zpool_vdev_remove_wanted
E073  cmd/zed/agents/zfs_retire.c:846  replace_with_spare
E073  cmd/zed/agents/zfs_retire.c:683  spare_on_remove
E073  cmd/zed/agents/zfs_retire.c:459  spare_is_preferred
E073  cmd/zed/agents/zfs_retire.c:509  zpool_vdev_attach
E074  cmd/zed/agents/zfs_mod.c:937  devid_iter
E074  cmd/zed/agents/zfs_mod.c:336  zpool_vdev_online
E075  cmd/zed/agents/zfs_mod.c:357  ZPOOL_PROP_AUTOREPLACE
E075  cmd/zed/agents/zfs_mod.c:575  zpool_vdev_attach
E076  cmd/zpool/zpool_main.c:12957  zpool_events_next
E077  cmd/zpool/zpool_main.c:12970  zpool_do_events_short
E077  cmd/zpool/zpool_main.c:12973  zpool_do_events_nvprint
E078  lib/libzfs/libzfs_pool.c:1374  zpool_refresh_stats
E078  cmd/zpool/zpool_main.c:10797  zpool_get_errlog
E079  lib/libzfs/libzfs_config.c:224  ZFS_IOC_POOL_STATS
E079  lib/libzfs/libzfs_pool.c:5219  ZFS_IOC_ERROR_LOG
E080  module/zfs/zfs_ioctl.c:1875  spa_get_stats
E080  module/zfs/vdev_label.c:658  vdev_config_generate_stats
E080  module/zfs/vdev_label.c:232  vdev_get_stats_ex
E081  module/zfs/spa.c:7057  spa_approx_errlog_size
E081  module/zfs/zfs_ioctl.c:6563  spa_get_errlog
E081  module/zfs/spa_errlog.c:1155  process_error_log
E081  module/zfs/spa_errlog.c:1165  process_error_list
E082  module/zfs/zfs_ioctl.c:1879  put_nvlist
E082  module/zfs/spa.c:7061  ZPOOL_CONFIG_SUSPENDED
E083  cmd/zpool/zpool_main.c:2938  vs_read_errors
E083  cmd/zpool/zpool_main.c:2872  vs_slow_ios
E083  cmd/zpool/zpool_main.c:11637  print_error_log
E083  cmd/zpool/zpool_main.c:10822  zpool_obj_to_path
E084  cmd/zpool/zpool_main.c:8349  zpool_clear
E085  lib/libzfs/libzfs_pool.c:3824  ZFS_IOC_VDEV_SET_STATE
E085  lib/libzfs/libzfs_pool.c:3665  ZFS_IOC_VDEV_SET_STATE
E085  lib/libzfs/libzfs_pool.c:3757  ZFS_IOC_VDEV_SET_STATE
E086  lib/libzfs/libzfs_pool.c:4698  ZFS_IOC_CLEAR
E087  lib/libzfs/libzfs_pool.c:4021  ZFS_IOC_VDEV_ATTACH
E088  module/zfs/zfs_ioctl.c:2367  vdev_fault
E088  module/zfs/zfs_ioctl.c:2375  vdev_degrade
E089  module/zfs/zfs_ioctl.c:2354  vdev_online
E089  module/zfs/zfs_ioctl.c:2379  vdev_remove_wanted
E090  module/zfs/zfs_ioctl.c:2404  spa_vdev_attach
E091  module/zfs/vdev.c:4641  VDEV_STATE_FAULTED
E091  module/zfs/vdev.c:4647  vdev_dtl_required
E091  module/zfs/vdev.c:4655  vdev_reopen
E091  module/zfs/vdev.c:4658  VDEV_STATE_DEGRADED
E092  module/zfs/vdev.c:4695  VDEV_STATE_DEGRADED
E093  module/zfs/vdev.c:4768  vdev_reopen
E094  module/zfs/vdev.c:4721  vdev_probe
E095  module/zfs/vdev.c:4725  SPA_ASYNC_REMOVE_BY_USER
E096  module/zfs/vdev.c:3010  vdev_open
E096  module/zfs/vdev.c:3052  vdev_propagate_state
E096  module/zfs/vdev.c:5800  vdev_op_state_change
E097  module/zfs/vdev.c:2486  dsl_scan_assess_vdev
E098  module/zfs/dsl_scan.c:5497  vdev_resilver_needed
E099  module/zfs/dsl_scan.c:5501  SPA_ASYNC_RESILVER
E099  module/zfs/dsl_scan.c:5510  vdev_defer_resilver
E100  module/zfs/zfs_ioctl.c:6645  vdev_clear
E101  module/zfs/vdev.c:4980  vs_read_errors
E102  module/zfs/vdev.c:5010  vdev_forcefault
E102  module/zfs/vdev.c:5017  vdev_reopen
E103  module/zfs/vdev.c:5030  ESC_ZFS_VDEV_CLEAR
E104  module/zfs/vdev.c:5044  zfs_ereport_clear
E105  module/zfs/zfs_ioctl.c:6653  zio_resume
E105  module/zfs/zfs_ioctl.c:6626  spa_mmp_remote_host_activity
E106  module/zfs/zio.c:3076  cv_broadcast
E106  module/zfs/zio.c:3087  zio_reexecute
E106  module/zfs/zio.c:3011  __zio_execute
E107  module/zfs/zio.c:3033  FM_EREPORT_ZFS_IO_FAILURE
E107  module/zfs/zfs_fm.c:531  FM_EREPORT_PAYLOAD_ZFS_POOL_FAILMODE
E108  module/zfs/dmu_tx.c:1073  ESHUTDOWN
E108  module/zfs/dmu_tx.c:1275  ZIO_FAILURE_MODE_CONTINUE
E108  module/zfs/dmu_tx.c:1325  dmu_tx_wait
E108  module/zfs/dmu_tx.c:1409  txg_wait_synced_flags
E109  module/zfs/spa.c:11529  spa_sync_rewrite_vdev_config
E110  module/zfs/spa.c:11395  zio_suspend
E110  module/zfs/spa.c:11396  zio_resume_wait
E111  module/zfs/spa.c:11207  spa_errlog_sync
E111  module/zfs/spa_errlog.c:1359  sync_error_list
E111  module/zfs/spa_errlog.c:1366  delete_errlog
E111  module/zfs/spa_errlog.c:1367  spa_errlog_scrub
E112  module/zfs/spa.c:11241  vdev_sync
E112  module/zfs/vdev.c:4453  vdev_dtl_sync
E113  module/zfs/spa.c:11231  dsl_scan_sync
E113  module/zfs/dsl_scan.c:4832  dsl_scan_done
E114  module/zfs/dsl_scan.c:1304  spa_errlog_rotate
E114  module/zfs/spa_errlog.c:1188  spa_scrub_finished
E115  module/zfs/dsl_scan.c:1347  zfs_ereport_clear
E116  module/zfs/dsl_scan.c:1294  ESC_ZFS_RESILVER_FINISH
E116  module/zfs/dsl_scan.c:1298  ESC_ZFS_SCRUB_FINISH
E117  module/zfs/spa.c:8829  vdev_add_parent
E117  module/zfs/spa.c:8847  vdev_propagate_state
E118  module/zfs/spa.c:8895  vdev_dtl_dirty
E119  module/zfs/spa.c:8899  spa_spare_activate
E119  module/zfs/spa.c:8900  ESC_ZFS_VDEV_SPARE
E119  module/zfs/spa.c:8936  ESC_ZFS_VDEV_ATTACH
E120  module/zfs/spa.c:8927  dsl_scan_restart_resilver
E120  module/zfs/spa.c:8918  vdev_rebuild
E120  module/zfs/spa.c:8925  vdev_defer_resilver
E121  cmd/zpool/zpool_main.c:388  zpool_do_status
E121  cmd/zpool/zpool_main.c:412  zpool_do_events
```

## Appendix D. Tunable and property source references

Where each tunable and pool or vdev property named in section 8 is declared, at commit `c913da8615`. A tunable's symbol is the name as written in its `ZFS_MODULE_PARAM` (or `ZFS_MODULE_PARAM_CALL`) line; a property's symbol is its quoted name in the `zprop_register_*()` call in `module/zcommon/zpool_prop.c`.

```
zfs_checksum_events_per_second  module/zfs/vdev.c:7393  checksum_events_per_second
zfs_deadman_checktime_ms  module/zfs/spa_misc.c:3487  checktime_ms
zfs_deadman_enabled  module/zfs/spa_misc.c:3490  enabled
zfs_deadman_events_per_second  module/zfs/vdev.c:7383  deadman_events_per_second
zfs_deadman_failmode  module/zfs/spa_misc.c:3502  failmode
zfs_deadman_synctime_ms  module/zfs/spa_misc.c:3506  synctime_ms
zfs_deadman_ziotime_ms  module/zfs/spa_misc.c:3510  ziotime_ms
zfs_slow_io_events_per_second  module/zfs/vdev.c:7380  slow_io_events_per_second
zfs_zevent_len_max  module/zfs/fm.c:1362  len_max
zfs_zevent_retain_expire_secs  module/zfs/zfs_fm.c:1606  retain_expire_secs
zfs_zevent_retain_max  module/zfs/zfs_fm.c:1604  retain_max
zio_deadman_log_all  module/zfs/zio.c:6738  deadman_log_all
zio_slow_io_ms  module/zfs/zio.c:6717  slow_io_ms
autoreplace  module/zcommon/zpool_prop.c:196  "autoreplace"
failmode  module/zcommon/zpool_prop.c:213  "failmode"
checksum_n  module/zcommon/zpool_prop.c:522  "checksum_n"
checksum_t  module/zcommon/zpool_prop.c:525  "checksum_t"
io_n  module/zcommon/zpool_prop.c:528  "io_n"
io_t  module/zcommon/zpool_prop.c:531  "io_t"
slow_io_n  module/zcommon/zpool_prop.c:534  "slow_io_n"
slow_io_t  module/zcommon/zpool_prop.c:537  "slow_io_t"
slow_io_events  module/zcommon/zpool_prop.c:565  "slow_io_events"
```
