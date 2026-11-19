# ZFS pool import and export (build spec)

This spec describes a diagram of how OpenZFS finds, imports and exports a pool: how `zpool import` discovers pools by reading the labels on candidate devices or the cachefile, how the kernel probes each candidate with a read-only tryimport, how the real import picks the uberblock (the pool state) to load, checks the devices, the host that last used the pool and the feature flags, rewinds to an older txg when asked, claims the intent logs and starts syncing, why an import is refused, what happens when the file systems are mounted afterwards, and what `zpool export` writes before the pool leaves the system.

Source of truth: `https://github.com/openzfs/zfs` at commit `c913da86156eba3243cc1ef515e98d69887654a7` (master, 2026-11-13, version 2.4.99). Every function name, file path and tunable in this document was checked against that commit.

## 0. Instructions to the building agent

Render this spec with the viewer in `../viewer`, as extended by `zfs-viewer-suite-spec.md`. Treat sections 6 to 10 and the appendices as data. Do not add, remove or re-route nodes and wires unless you have verified the change in the source at the pinned commit.

## 1. Goal

One page that lets an administrator answer "how does `zpool import` find pools on my disks, which state of the pool does it load, what do -f, -F, -X, -N, -m, -d, -c and `-o readonly=on` do, why can an import be refused, what happens before the pool is usable, and what does `zpool export` guarantee?" by following wires between boxes.

### Mental model the diagram has to convey

1. Every device carries four labels, each with a copy of the pool configuration (a name-value list) and a ring of uberblocks. `zpool import` finds pools by reading only the configurations, in userspace, from every candidate device (or by reading the cachefile instead). The kernel never scans devices: it is handed a configuration and checks it.
2. Every import is done twice. First a tryimport opens the pool read-only under a temporary name to report its health, feature support and the host that uses it, then throws it away; `zpool import` with no pool name stops there. The real import starts again from that configuration.
3. The state that is loaded is the best uberblock found on any readable device: the highest txg (not above a requested maximum), then the latest timestamp. Its root block pointer opens the meta-object set (MOS), whose own copy of the configuration then replaces the one supplied by userspace. Nothing newer than that uberblock exists as far as the pool is concerned.
4. An import can be refused for several distinct reasons, checked in different places: zpool(8) itself refuses a pool that was not exported and was last used by another host, unless `-f`; with `multihost=on` the kernel watches the disks for another host's heartbeat and refuses whatever the flags say; unknown features refuse the import (only those needed for reading, with `-o readonly=on`); and missing devices refuse it when no redundancy covers them.
5. When the newest state cannot be loaded, `-F` walks back through older uberblocks still in the label rings, verifying each, and keeps the first that works, discarding the intent logs; `-X` allows going back further and verifies the whole pool; `-n` only reports what `-F` would do. Even without `-F` a failed import probes older txgs to tell you whether `-F` would help.
6. A writeable import changes the pool before you can use it: the uncommitted intent-log blocks are claimed so they are not reused, the sync thread starts, every label is rewritten with this host's id and the state ACTIVE, the cachefile is updated, and a resilver starts if any device missed writes. The logged writes themselves are replayed only when each file system is mounted. A read-only import skips all of this.
7. Export unmounts everything, waits until nothing holds the pool, then lets the last txgs sync with every label marked EXPORTED, closes the devices and removes the pool from the cachefile and from the kernel. A cleanly exported pool imports on any host without `-f`.

### Scope

In scope: `zpool import` (listing, by name or guid, `-a`, `-c`, `-d`, `-s`, `-f`, `-F`, `-n`, `-X`, `-m`, `-M`, `-N`, `-o readonly=on`, `--rewind-to-checkpoint`), device and label discovery in libzutil, the cachefile, the tryimport and import ioctls, `spa_load()` and its phases, uberblock selection, the host checks (hostid and multihost), the ZIL claim and the replay at mount, the work started after an import, the boot-time import services, and `zpool export` with `-f`, `-F` and `-a`.

Out of scope: pool creation and destruction (`zpool destroy`, `-D` imports of destroyed pools), `zpool split`, verbatim import (`-V`), temporary names (`-t`), root pool import at boot on FreeBSD, encryption key loading (`-l`), zvol device creation, the events posted to zed, `zhack`, and the FreeBSD device scan.

## 2. Deliverable

The page is built by `../viewer/build_graph.py --spec specs/zfs-pool-import-export-spec.md --repo zfs` and validated by `../viewer/validate_graph.py` with the same spec. Its page name is `zfs-pool-import-export.html`; it belongs to the suite described in `zfs-viewer-suite-spec.md`.

## 6. Wire types and contexts

### 6.1 Wire types

The colours are the suite-wide colours of `README.md` section 6. `cfg` is reserved for the pool create, dataset create, import/export and destroy graphs.

| type id | colour | name | what travels on the wire |
|---|---|---|---|
| `cfg` | `#FFD8A8` | Configuration and properties | Pool configuration nvlists (from labels, the cachefile, tryimport or the MOS), vdev trees, uberblocks read from the labels, load information returned to userspace, property lists. |
| `bp` | `#F783AC` | Block pointer | The root block pointer of the MOS, taken from the selected uberblock. |
| `zio` | `#4DABF7` | I/O request | Block reads through the zio pipeline (MOS reads, verification reads). |
| `log` | `#3BC9DB` | Intent-log record | Log chains and log blocks read, claimed or replayed. |
| `tx` | `#FFD43B` | Transaction | Starting, waiting for and stopping txg syncs. |
| `bio` | `#E9ECEF` | Device I/O | Label, uberblock and probe I/O at fixed offsets on a leaf device. |
| `ctl` | `#868E96` | Control | Calls that carry no configuration or payload: requests, checks, verdicts, errors. Draw dashed. |

### 6.2 Execution contexts

| ctx id | meaning |
|---|---|
| `user` | Userspace (`zpool` command, libzfs, libzutil, systemd units) |
| `syscall` | Kernel, in the thread of the calling process (an ioctl on /dev/zfs, mount(2) or umount(2)) or a helper thread it starts, outside syncing context and outside any dmu_tx |
| `open` | Open context: the calling thread (syscall / zvol worker), inside a dmu_tx |
| `sync` | Syncing context: txg_sync thread or dp_sync_taskq workers, one txg at a time |
| `thr` | A dedicated kernel thread or zthr |
| `any` | Runs in whichever context calls it |
| `hw` | Hardware |

## 7. Groups and default layout

Flow runs left to right: commands and discovery in userspace on the left, the ioctls and the SPA entry points next, the phases of `spa_load()` in the middle, then the sync machinery and background threads, and the devices on the right.

| group id | title | colour | first column | band | sub-columns | nodes | summary |
|---|---|---|---|---|---|---|---|
| `user` | Userspace - zpool, libzfs, libzutil | `#5C5F66` | 0 | full | 2 | 12 | Commands, device and label discovery, the cachefile reader, configuration assembly and the import, export and mount calls. |
| `kentry` | Kernel entry - ioctls, SPA | `#2B8A3E` | 2 | full | 1 | 6 | The pool ioctls, tryimport, import, export, unload and the namespace of imported pools. |
| `load` | spa_load() - opening the pool | `#E67700` | 3 | full | 3 | 14 | Every phase between a configuration nvlist and a usable pool: vdevs, labels, uberblock, host checks, MOS, features, logs, verification. |
| `mount` | Mount + ZIL | `#0C8599` | 6 | top | 2 | 3 | Mounting a file system after import, and the intent log claimed at import and replayed at mount. |
| `txg` | TXG sync, labels, background threads | `#1971C2` | 6 | bottom | 2 | 9 | The sync thread that writes labels and uberblocks, the MMP heartbeat, async work and the cachefile writer. |
| `dev` | Devices and files | `#495057` | 8 | full | 1 | 5 | Leaf devices, their labels, data and log devices, and the cachefile. |

Default layout rules:

- Column pitch is 400 px. A group starts at `first column * 400` and is `sub-columns` columns wide. A node's x is `(group first column + node sub-col) * 400`.
- Inside a sub-column, stack nodes top to bottom in the order they appear in the section 8 tables, 28 px apart. Node height follows its socket count.
- Band `full` groups start at the top. Groups `mount` (band `top`) and `txg` (band `bottom`) share columns 6 and 7: place `txg` 90 px below the bottom of `mount`.
- The layout must be deterministic. Do not run a force-directed or randomised layout in the page.
- Check the default at "fit all": group titles must be readable and no node may overlap another.

## 8. Nodes

49 nodes. `sub-col` is the node's column inside its group. `functions` are real symbols at the pinned commit (locations in Appendix A); the first one is the node's headline function. Nine nodes are shared with the I/O flow graph and keep its ids, titles and contexts. Others are shared with the other graphs: `zpool_cmd`, `spa_ns`, `spa_unload`, `cachefile` (pool create), `vdev_open` (pool create, fault management), `spa_export`, `vfs_umount` (destroy), `mount_lib` (encryption, dataset create, destroy), `zpl_mount` (dataset create), `resilver_start` and `suspend` (fault management), `spa_async` (scrub and resilver).

### 8.1 Userspace - zpool, libzfs, libzutil (`user`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `admin` | Administrator | 0 | `user` | - | - | The person or script typing the command. Every path in this graph that a command starts begins with a wire from this node; the arrows that come back into a command node are its results, errors and refusals. |
| `boot_import` | Boot import services (systemd) | 0 | `user` | `etc/systemd/system/zfs-import-cache.service.in` | - | At boot on Linux with systemd, `zfs-import-cache.service` runs `zpool import -c /etc/zfs/zpool.cache -aN`; when the cachefile is missing or empty, `zfs-import-scan.service` runs `zpool import -aN -o cachefile=none` instead. Both import without mounting (`-N`); `zfs-mount.service` later runs `zfs mount -a`. The kernel module itself imports nothing at load time: the cachefile is read only by userspace. |
| `zpool_cmd` | zpool(8) command | 0 | `user` | `cmd/zpool/zpool_main.c` | `zpool_do_import`, `import_pools`, `do_import`, `do_import_task`, `show_import`, `zpool_do_export`, `zpool_export_one` | `zpool import` builds the search arguments (`-d` directories or `ZPOOL_IMPORT_PATH`, `-c` cachefile, `-s` scan, pool name or numeric guid) and the load policy (`-F` do rewind, `-n` try rewind, `-X` extreme rewind, `-T` txg, `-M` relaxed metadata checks), searches, then lists the pools (no argument), imports all (`-a`, in parallel on a taskq) or the one named. `-o name=value` sets a pool property, `-o opts` gives mount options, `-R` sets altroot and cachefile=none. A failed `-c` import is retried once by scanning the directories named in the cachefile. `zpool export` unmounts and exports each named pool, or all pools in parallel with `-a`. |
| `force_check` | Host check (zfs_force_import_required) | 0 | `user` | `cmd/zpool/zpool_main.c` | `zfs_force_import_required`, `get_system_hostid` | The only place the classic `-f` check lives: a pool whose state is not EXPORTED and whose hostid (from the MOS config, via tryimport) differs from this system's needs `-f`. It also refuses, without `-f`, when tryimport saw MMP activity or the pool has multihost=on and this system has no hostid. The kernel never reads the `-f` flag (ZFS_IMPORT_ANY_HOST). |
| `mount_lib` | libzfs mount / unmount | 0 | `user` | `lib/libzfs/libzfs_mount.c` | `zpool_enable_datasets`, `zfs_mount_one`, `zfs_mount_at`, `zpool_disable_datasets`, `unmount_one` | After an import, `zpool_enable_datasets()` gathers every file system of the pool, mounts them in mountpoint order with a pool of threads (datasets whose key is not loaded are skipped), then shares them one by one. Before an export, `zpool_disable_datasets()` takes the pool's file systems from the mount table, not from the pool, unshares them, then unmounts them in reverse mountpoint order; `-f` passes MS_FORCE. Volumes are not handled here. |
| `libzutil_search` | Pool search (zpool_search_import) | 0 | `user` | `lib/libzutil/zutil_import.c` | `zpool_search_import`, `zpool_find_import`, `zpool_find_import_impl` | Chooses between the cachefile and a device search. For a device search it opens every candidate on a taskq (about two threads per CPU), reads its labels, keeps those of the requested pool (by name or guid, spares and cache devices always), drops devices that cannot be opened exclusively (for example multipath members), and hands the labels to configuration assembly. |
| `dev_scan` | Device discovery (blkid / directory scan) | 0 | `user` | `lib/libzutil/os/linux/zutil_import_os.c` | `zpool_find_import_blkid`, `zpool_find_import_scan`, `zpool_find_import_scan_dir`, `zpool_default_search_paths` | Produces the list of candidate devices. By default on Linux it asks libblkid for every device of TYPE zfs_member. With `-d`, ZPOOL_IMPORT_PATH or `-s` it lists every entry of the given directories, or of the default search path (/dev/disk/by-vdev, /dev/mapper, by-partlabel, by-partuuid, by-label, by-uuid, by-id, by-path, then /dev). Each candidate gets a preference order, used later to pick the best name for a device found under several paths. |
| `cache_read` | Cachefile reader | 0 | `user` | `lib/libzutil/zutil_import.c` | `zpool_find_import_cached`, `discover_cached_paths` | `zpool import -c <file>`: reads and unpacks the whole cachefile and takes each pool's configuration from it as is, skipping pools already imported. No label is read in userspace, so paths in the cachefile must still be right. In the fallback scan after a failed cachefile import, only the directories that hold the cached device paths are scanned for that pool's guid. |
| `label_read_user` | Label reader (zpool_open_func) | 1 | `user` | `lib/libzutil/os/linux/zutil_import_os.c` | `zpool_open_func`, `zpool_read_label` | Opens one candidate read-only (O_DIRECT when possible, to avoid stale multipath caches) and reads the configuration nvlist of each of its four labels in one asynchronous batch. The first valid label supplies the config and the others with the same vdev guid are counted; labels with txg 0 (written before the device was in use) are skipped, and a device with no valid label is ignored. When a label names another path or devid for the same vdev, that path is tried too. Uberblocks are not read in userspace. |
| `get_configs` | Configuration assembly (get_configs) | 1 | `user` | `lib/libzutil/zutil_import.c` | `add_config`, `get_configs`, `fix_paths` | Groups the labels by pool guid, then by top-level vdev guid, then by txg. For each top-level vdev the label with the highest txg supplies that vdev's subtree; the pool-wide fields (name, state, hostid, number of top-level vdevs, holes) come from the newest label of all. Missing top-level vdevs become placeholders. Each device's path is set to the best name it was found under. Pools already imported here are dropped, and each remaining configuration is sent to the kernel for a tryimport. |
| `libzfs_import` | libzfs import / tryimport | 1 | `user` | `lib/libzfs/libzfs_pool.c` | `refresh_config`, `zpool_import_props`, `zpool_explain_recover`, `zpool_rewind_exclaim` | Wraps the two import ioctls. `refresh_config()` sends a configuration for a tryimport and returns the kernel's version of it. `zpool_import_props()` validates the new name and the `-o` properties, sends the import, and turns the kernel's errors and load information into messages: unsupported features, the host that holds the pool, missing log devices, or what a rewind would cost. |
| `libzfs_export` | libzfs export | 1 | `user` | `lib/libzfs/libzfs_pool.c` | `zpool_export`, `zpool_export_force`, `zpool_export_common` | Sends ZFS_IOC_POOL_EXPORT. `zpool_export()` passes force (from `zpool export -f`), which only overrides the active shared spare check; `zpool_export_force()` (from `-F`) also passes hardforce. The caller must have unmounted the file systems first. |

### 8.2 Kernel entry - ioctls, SPA (`kentry`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `ioc_pool` | Pool ioctls (tryimport, import, export) | 0 | `syscall` | `module/zfs/zfs_ioctl.c` | `zfs_ioc_pool_tryimport`, `zfs_ioc_pool_import`, `zfs_ioc_pool_export` | Kernel entry for ZFS_IOC_POOL_TRYIMPORT, ZFS_IOC_POOL_IMPORT and ZFS_IOC_POOL_EXPORT. Import and tryimport return the configuration, including the load information, in the destination nvlist even when they fail, which is how userspace learns why. |
| `spa_tryimport` | spa_tryimport() | 0 | `syscall` | `module/zfs/spa.c` | `spa_tryimport` | Loads the pool read-only under a temporary name (`$import-<thread>-<pool>`) with a missing log device tolerated, then generates a full configuration from whatever opened: vdev tree with states, pool state, the loaded uberblock's timestamp, the load information (MMP state, enabled and unsupported features, the MOS hostid and hostname), spares, cache devices and bootfs. Then it unloads and removes the temporary pool. Nothing is written. |
| `spa_import` | spa_import() | 0 | `syscall` | `module/zfs/spa.c` | `spa_import`, `spa_activate`, `spa_configfile_set` | Refuses a name already in use, creates the spa_t, activates it read-write or read-only (`readonly=on` in the properties), keeps async work suspended, loads the pool with the rewind policy, and on success applies the properties, refreshes spares and cache devices, updates the config and cachefile (writeable pools only), requests autoexpand, logs the import in the pool history and creates zvol devices. On failure it unloads and removes the spa_t again. Properties: `readonly`, `altroot`. |
| `spa_export` | spa_export_common() | 0 | `syscall` | `module/zfs/spa.c` | `spa_export`, `spa_export_common` | Export (and, with other states, destroy and reset). Marks the pool as exporting, stops async work, waits for a txg so that objsets held only by dirty data are released, then refuses with EBUSY if anything still holds the pool. Removes zvol devices, refuses an active shared spare unless forced, stops initialize, TRIM, rebuild and L2ARC rebuild, sets the pool state to EXPORTED and dirties every label (unless hardforce), may flush metaslabs to shrink the log space maps, fixes the final txg, unloads, rewrites the cachefile without the pool (unless hardforce) and removes it from the namespace. |
| `spa_unload` | spa_unload() | 0 | `syscall` | `module/zfs/spa.c` | `spa_unload`, `spa_deactivate` | Tears a loaded pool down: stops the sync threads after the final txgs, stops the MMP thread, waits for outstanding async I/O, closes every vdev, closes the DSL pool and unloads DDT, BRT and the log space maps. Also used between load attempts and after a tryimport. |
| `spa_ns` | SPA namespace | 0 | `syscall` | `module/zfs/spa_misc.c` | `spa_lookup`, `spa_add`, `spa_remove` | The kernel's AVL tree of spa_t by name, under spa_namespace_lock. A pool is "imported" exactly while it is in this tree. `spa_add()` also decides the cachefile: the default path unless an altroot is given. A lookup of a pool that is being exported waits until the export finishes. |

### 8.3 spa_load() - opening the pool (`load`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `load_best` | spa_load_best(): rewind loop | 0 | `syscall` | `module/zfs/spa.c` | `spa_load_best`, `spa_load_retry` | Runs `spa_load()` and, when it fails for a reason a rewind could fix, loads again with the maximum txg set just below the uberblock that failed, until a load succeeds or the minimum txg is passed: the newest txg minus TXG_DEFER_SIZE normally, TXG_INITIAL with `-X`. In RECOVER state (`-F`) the first good load is the pool and the intent logs are discarded. Otherwise the original error is returned and the older loads, which wrote nothing, are reported as rewind information. Errors that a rewind cannot fix (another host active, interrupted, no checkpoint) end the search at once. |
| `spa_load` | spa_load() / spa_load_impl() | 0 | `syscall` | `module/zfs/spa.c` | `spa_load`, `spa_load_impl`, `spa_ld_mos_init`, `spa_ld_mos_with_trusted_config`, `spa_ld_claim_log_blocks`, `spa_ld_check_for_config_update` | Drives the load phases in order: parse the provided config, open and validate the vdevs, select the uberblock, open the MOS, switch to the trusted config, optional checkpoint rewind, checkpoint txg, indirect vdevs, features, special directories, properties, spares and cache devices, vdev metadata, dedup tables, BRT, log checks, verification. Only for a writeable load at the newest txg (or in RECOVER state) does it go on to claim the logs, start the sync and MMP threads, wait for the claims to sync, request a config update and a resilver if needed, restart removals, clean up inconsistent datasets and restart initialize and TRIM. Posts an ereport when the load fails. |
| `ld_parse` | Parse the provided config | 0 | `syscall` | `module/zfs/spa.c` | `spa_ld_parse_config`, `spa_config_parse` | Turns the configuration from userspace into an in-memory vdev tree. This config is untrusted: until the MOS copy is loaded the pool cannot be written. Refuses a pool guid that is already imported (EEXIST). |
| `vdev_open` | vdev_open() / vdev_reopen() | 0 | `any` | `module/zfs/vdev.c` | `vdev_open`, `vdev_open_children`, `vdev_root_open`, `vdev_mirror_state_change`, `spa_ld_open_vdevs` | Opens the whole tree bottom-up; each leaf is opened through its driver and probed with a test read. A mirror or raidz with enough children left is DEGRADED, otherwise it cannot open. The root opens only if no more top-level vdevs are missing than allowed: zfs_max_missing_tvds_cachefile (2) for an untrusted config from a cachefile, zfs_max_missing_tvds_scan (0) from a scan, never fewer than zfs_max_missing_tvds; a pool with a top-level vdev missing can be opened only read-only. Tunables: `zfs_max_missing_tvds`, `zfs_max_missing_tvds_cachefile`, `zfs_max_missing_tvds_scan`. |
| `ld_validate` | vdev_validate(): labels vs config | 0 | `syscall` | `module/zfs/vdev.c` | `spa_ld_validate_vdevs`, `vdev_validate`, `vdev_label_read_config` | Reads each readable leaf's label (the two at the start of the device first, because the trailing pair moves when a device grows) and checks it against the config: the vdev guid and top-level guid must match, the pool guid too once the config is trusted, and a vdev split off into another pool is refused. A leaf that fails is marked CANT_OPEN; the load fails if that leaves the root unopenable. |
| `ub_select` | Uberblock selection | 1 | `syscall` | `module/zfs/spa.c` | `spa_ld_select_uberblock`, `vdev_uberblock_load`, `vdev_uberblock_load_done`, `vdev_uberblock_compare`, `spa_ld_select_uberblock_done` | Reads every uberblock slot of every trusted label of every readable leaf and keeps the best one not above spa_load_max_txg: highest txg, then latest timestamp, then highest MMP sequence. Each sync writes its uberblock into slot txg modulo the ring size, so the rings hold the most recent txgs. The configuration of that uberblock's txg is then read from the same leaf. Runs the multihost check, refuses an unsupported version or an unknown feature in the label's features_for_read, and sets the first txg the pool will write: normally the loaded txg + 1, but above the newest uberblock seen when an older txg was requested. |
| `mmp_check` | MMP activity check and claim | 1 | `syscall` | `module/zfs/spa.c` | `spa_activity_check_required`, `spa_ld_activity_check`, `spa_activity_check_duration`, `spa_activity_check_tryimport`, `spa_activity_verify_config`, `spa_activity_check_claim`, `mmp_claim_uberblock` | For a pool whose uberblock shows MMP in use, unless it was exported by this very host (or destroyed). A system without a hostid is refused. At tryimport the best uberblock is reread about once a second for the check duration: by default the owner's fail intervals times its MMP interval times 2 (20 s with the defaults), plus up to 25% at random; any change means another host is active. At import the tryimport result is reused when the uberblock is unchanged; then, once the trusted config is loaded, the host claims the pool: ten times, one MMP interval apart, it writes the best uberblock with a random sequence to an MMP slot of every writeable leaf and reads back that its own write is the best. The `-f` flag does not skip any of this. A rewind (`-F`, state RECOVER) skips the watch; the claim is skipped only for an extreme rewind. Tunables: `zfs_multihost_import_intervals`, `zfs_multihost_interval`. Properties: `multihost`. |
| `ld_mos_open` | Open the MOS (dsl_pool_init) | 1 | `syscall` | `module/zfs/spa.c` | `spa_ld_open_rootbp`, `dsl_pool_init` | Creates the DSL pool at the first txg and opens the MOS objset from the uberblock's root block pointer. From here on every phase reads MOS objects through the normal read path. |
| `ld_trusted` | Trusted config from the MOS | 1 | `syscall` | `module/zfs/spa.c` | `spa_ld_trusted_config`, `spa_ld_prepare_for_reload`, `vdev_copy_path_strict` | Loads the pool configuration stored in the MOS, builds a new vdev tree from it, copies the device paths over from the provided config (which came from the scan or the cachefile, so its paths are current), replaces the old tree and marks the config trusted, which makes the pool writeable. Reopens and revalidates the vdevs. If the provided config missed top-level vdevs that the MOS knows, the whole MOS init is redone once with the trusted config, so a newer uberblock on those vdevs is not missed. Then the multihost claim, the missing log check and the check that the vdev guid sum matches the uberblock's. Records the MOS hostid and hostname in the load information. |
| `ckpt_rewind` | Checkpoint rewind | 1 | `syscall` | `module/zfs/spa.c` | `spa_ld_checkpoint_rewind` | `zpool import --rewind-to-checkpoint`: reads the checkpointed uberblock saved in the MOS, gives it the current txg + 1 and the current time so it outranks every uberblock on disk, and on a writeable import writes it to the labels. The load then starts over from that uberblock. Imported read-only, the checkpointed state can be inspected without writing anything. |
| `ld_features` | Feature flags check | 2 | `syscall` | `module/zfs/spa.c` | `spa_ld_check_features`, `spa_features_check` | Compares the features the MOS lists as needed for reading, and for writing when the import is writeable or a tryimport, with the features this software knows. An unknown read feature refuses the pool; an unknown write feature refuses a writeable import but allows `-o readonly=on`, which userspace is told through ZPOOL_CONFIG_CAN_RDONLY. Loads every feature's reference count into memory. |
| `ld_meta` | MOS metadata load | 2 | `syscall` | `module/zfs/spa.c` | `spa_ld_load_special_directories`, `dsl_pool_open`, `spa_ld_get_props`, `spa_ld_open_aux_vdevs`, `spa_ld_load_vdev_metadata`, `vdev_load` | Opens the DSL directories, reads the pool properties (and forces failmode=continue when top-level vdevs are missing), opens spares and cache devices, loads each vdev's metaslab array, space maps and DTLs, then the dedup tables and the block reference table. With autoreplace=on, unopenable devices are reported for replacement. Properties: `failmode`. |
| `ld_logs` | Log device checks | 2 | `syscall` | `module/zfs/spa.c` | `spa_check_for_missing_logs`, `spa_ld_verify_logs`, `spa_check_logs` | A log device that cannot be opened refuses the import with ENXIO and is listed for the user, unless `-m` (ZFS_IMPORT_MISSING_LOG), which drops the intent log instead (tryimport always behaves as if `-m` was given). On a writeable import every dataset's log chain is also checked; a broken chain refuses the import unless top-level vdevs are missing. |
| `ld_verify` | spa_load_verify(): recent txgs | 2 | `syscall` | `module/zfs/spa.c` | `spa_ld_verify_pool_data`, `spa_load_verify`, `spa_load_verify_cb`, `spa_load_verify_done` | Not for a tryimport. Traverses every block born after spa_verify_min_txg (the last few txgs; the whole pool with `-X`) and reads metadata blocks, and data blocks only when the count is reported (`zpool import -nF`), at scrub priority with at most 1/2^spa_load_verify_shift of the ARC target in flight. By default any metadata error fails the load with EIO, which is what makes a rewind try an older txg; `-M` counts errors in non-critical metadata as data errors. On success the txg, its timestamp and the error counts go into the load information. Tunables: `spa_load_verify_metadata`, `spa_load_verify_data`, `spa_load_verify_shift`. |

### 8.4 Mount + ZIL (`mount`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `zpl_mount` | zpl mount (zfs_domount) | 0 | `syscall` | `module/os/linux/zfs/zfs_vfsops.c` | `zfs_domount`, `zpl_get_tree`, `zfsvfs_setup` | mount(2) of a ZFS file system: owns the dataset, sets up the zfsvfs, opens its ZIL and, on a writeable pool, replays it before the mount completes (a read-only mount lifts its read-only flag for the replay). Linux names; FreeBSD has the equivalents in its own zfs_vfsops.c. |
| `vfs_umount` | Kernel unmount (zfs_umount) | 0 | `syscall` | `module/os/linux/zfs/zfs_vfsops.c` | `zfs_umount`, `zfsvfs_teardown` | umount(2) of a ZFS file system: `zfsvfs_teardown()` closes the ZIL, so outstanding log records are committed, and the dataset is disowned, which drops its hold on the pool. Until every file system of the pool is unmounted this way, the export cannot pass its reference check. |
| `zil_replay` | zil_claim() / zil_replay() | 1 | `open` | `module/zfs/zil.c` | `zil_claim`, `zil_parse`, `zil_claim_log_block`, `zil_replay` | Shared with the I/O flow graph. At import, `zil_claim()` runs for every dataset in one tx of the first txg: it walks the log chain and marks each log block born after the last synced txg as allocated, so the allocator cannot hand it out before replay, and records that a replay is needed. When the log is being cleared (rewind, `-m`, a checkpoint rewind) the chain is freed instead. At mount, `zil_replay()` re-executes each claimed record as a normal transaction and then destroys the log. |

### 8.5 TXG sync, labels, background threads (`txg`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `txg_sync` | TXG: syncing (txg_sync_thread) | 0 | `thr` | `module/zfs/txg.c` | `txg_sync_start`, `txg_sync_thread`, `txg_wait_synced`, `txg_sync_stop` | Shared with the I/O flow graph. Started by a writeable import once the logs are claimed; never started for a read-only import. At export, `txg_sync_stop()` waits for the open txg plus TXG_DEFER_SIZE to sync, then stops the quiesce and sync threads. |
| `spa_sync` | spa_sync() | 0 | `sync` | `module/zfs/spa.c` | `spa_sync` | Shared with the I/O flow graph. Each txg ends with the label and uberblock update, and then dispatches pending async requests. |
| `uberblock` | Uberblock + label update | 0 | `sync` | `module/zfs/vdev_label.c` | `spa_sync_rewrite_vdev_config`, `vdev_config_sync`, `uberblock_update` | Shared with the I/O flow graph. When the configuration is dirty (after an import, at export) every label of every vdev is rewritten with the current config, which carries the pool state, this host's hostid and hostname; otherwise only uberblocks are written, to a few top-level vdevs. Also writes the checkpointed uberblock during a checkpoint rewind. |
| `vdev_label` | Label / uberblock writer | 0 | `sync` | `module/zfs/vdev_label.c` | `vdev_label_sync_list`, `vdev_uberblock_sync_list`, `vdev_label_write` | Shared with the I/O flow graph. Writes the even labels, then the uberblock, then the odd labels, flushing the disk write caches after each step, so that a crash at any point leaves labels that match a valid uberblock. |
| `mmp` | MMP heartbeat thread | 1 | `thr` | `module/zfs/mmp.c` | `mmp_thread_start`, `mmp_thread`, `mmp_write_uberblock`, `mmp_update_uberblock`, `mmp_thread_stop` | Started with every writeable import, writes only while multihost=on. It keeps rewriting the last synced uberblock, with a fresh timestamp and sequence number, into the reserved MMP slots of the label rings: one leaf every zfs_multihost_interval divided by the number of leaves. This is the heartbeat another host's import watches for. If no write succeeds for zfs_multihost_fail_intervals times the interval it suspends the pool, so it stops writing before an importer's check could end. Tunables: `zfs_multihost_interval`, `zfs_multihost_fail_intervals`. Properties: `multihost`. |
| `spa_async` | spa_async_thread() | 1 | `thr` | `module/zfs/spa.c` | `spa_async_request`, `spa_async_dispatch`, `spa_async_thread`, `spa_async_autoexpand`, `spa_async_suspend`, `spa_async_resume` | Work requested during import that runs once the pool is up: the config and cachefile update, the resilver, autoexpand events (only with autoexpand=on), L2ARC rebuild and the sweep of deferred snapshot destroys. Requests are only recorded; the thread is started at the end of a spa_sync() and not while async work is suspended (during the import itself and from the start of an export). Properties: `autoexpand`. |
| `resilver_start` | Resilver trigger | 1 | `any` | `module/zfs/vdev.c` | `vdev_resilver_needed`, `dsl_scan_restart_resilver` | At the end of a writeable import, a sequential rebuild that was in progress is resumed; otherwise, if no resilver is already running and any leaf's DTL records txgs it missed, a resilver is requested from the async thread. |
| `suspend` | Pool suspend / resume | 1 | `any` | `module/zfs/zio.c` | `zio_suspend` | Reached here from the MMP thread when heartbeat writes stop landing: the pool suspends with ZIO_SUSPEND_MMP. `zpool clear` resumes it only after checking that no other host has imported the pool meanwhile. |
| `cachefile` | Pool cache file (zpool.cache) | 1 | `syscall` | `module/zfs/spa_config.c` | `spa_config_update`, `spa_write_cachefile`, `spa_config_write`, `spa_config_generate` | The kernel code that keeps the cachefile up to date, run in the ioctl thread for import and export and in the async thread for later updates. `spa_config_update()` dirties every label and waits for that txg, so the labels carry the new config, then writes the cachefile. `spa_write_cachefile()` writes, for each cachefile this pool uses or used, the configs of every writeable pool that uses it, in place (truncate, write, fsync); a cachefile left with no pools is removed. Read-only pools and pools with cachefile=none (or an altroot) are never written. Tunables: `spa_config_path`. Properties: `cachefile`. |

### 8.6 Devices and files (`dev`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `vdev_leaf` | Leaf vdev driver | 0 | `any` | `module/os/linux/zfs/vdev_disk.c` | `vdev_disk_open`, `vdev_disk_close`, `vdev_geom_open` | Shared with the I/O flow graph. Opens a leaf device by the absolute path in the config (Linux `vdev_disk_open()`, which retries for a short while when the device node does not exist yet; FreeBSD `vdev_geom_open()`), and releases it when the vdev is closed. |
| `dev_labels` | Labels L0-L3 + uberblock ring | 0 | `hw` | - | - | Shared with the I/O flow graph. Four labels per leaf, two at the start and two at the end of the device. Each holds the vdev configuration nvlist (pool name and guid, state, txg, hostid and hostname, this vdev's top-level subtree) and a ring of uberblocks; with multihost=on the last slots of each ring are reserved for MMP writes. |
| `dev_normal` | Data disks (normal class) | 0 | `hw` | - | - | Shared with the I/O flow graph. Here: where the MOS and the blocks checked by `spa_load_verify()` are read from. |
| `dev_slog` | SLOG (log class) | 0 | `hw` | - | - | Shared with the I/O flow graph. Holds the intent-log chains that are claimed at import and replayed at mount; without a log device the chains are in the main pool. |
| `zpool_cache` | zpool.cache file on disk | 0 | `hw` | - | - | /etc/zfs/zpool.cache unless the cachefile property names another file: one packed nvlist with the configuration of every pool that uses it. Written only by the kernel, read only by userspace (`zpool import -c`, the boot service). It saves the device scan at boot. A stale one cannot make the kernel load the wrong state, because the kernel checks it against the labels and the MOS; at worst the import fails and zpool(8) falls back to a scan. |

## 9. Wires

104 wires. A wire runs from the node that hands something over to the node that receives it. Returns from function calls are mostly not drawn; a wire shows where a configuration, a verdict or control goes next. `on paths` lists the section 10 paths that use the wire.

| wire | from | to | type | label | on paths |
|---|---|---|---|---|---|
| E001 | `zpool_cmd` | `libzutil_search` | `ctl` | zpool import: zpool_do_import() gathers -d, -c, -s, the pool name or guid and the load policy, then zpool_search_import() | discover, import, boot |
| E002 | `libzutil_search` | `dev_scan` | `ctl` | zpool_find_import(): candidates from libblkid (zpool_find_import_blkid()) by default, or zpool_find_import_scan() of the -d directories, ZPOOL_IMPORT_PATH or, with -s, the default search path | discover |
| E003 | `libzutil_search` | `label_read_user` | `ctl` | zpool_find_import_impl(): one zpool_open_func() task per candidate device on a taskq | discover, boot |
| E004 | `dev_labels` | `label_read_user` | `cfg` | zpool_read_label(): the configuration nvlist of all four labels in one lio_listio() batch, opened O_DIRECT when the device allows it; no uberblock is read | discover, boot |
| E005 | `label_read_user` | `get_configs` | `cfg` | labels of the requested pool (of every pool when listing), from devices that open with O_EXCL, go to add_config(): grouped by pool guid, top-level vdev guid and txg | discover, boot |
| E006 | `get_configs` | `libzfs_import` | `cfg` | get_configs(): per top-level vdev the newest label config, merged into one pool config, paths fixed by fix_paths(), pools already imported skipped, then zutil_refresh_config() | discover, boot |
| E007 | `libzfs_import` | `ioc_pool` | `cfg` | refresh_config(): ZFS_IOC_POOL_TRYIMPORT with the assembled config | discover, boot |
| E008 | `ioc_pool` | `spa_tryimport` | `cfg` | zfs_ioc_pool_tryimport() -> spa_tryimport() | discover, boot |
| E009 | `spa_tryimport` | `spa_ns` | `ctl` | spa_add() under a temporary name, spa_activate(SPA_MODE_READ); spa_remove() when done | discover |
| E010 | `spa_tryimport` | `spa_load` | `ctl` | spa_load(SPA_LOAD_TRYIMPORT), with ZFS_IMPORT_MISSING_LOG set so a missing log device does not stop the probe | discover, mmp, boot |
| E011 | `spa_load` | `ld_parse` | `cfg` | spa_ld_mos_init() -> spa_ld_parse_config() -> spa_config_parse(): the provided config becomes an untrusted vdev tree; a pool guid already imported is EEXIST | discover, import |
| E012 | `spa_load` | `vdev_open` | `ctl` | spa_ld_open_vdevs() -> vdev_open() on the root vdev, with the number of missing top-level vdevs allowed for this config source | discover, import, degraded |
| E013 | `vdev_open` | `vdev_leaf` | `ctl` | each leaf: vdev_op_open, Linux vdev_disk_open() or FreeBSD vdev_geom_open(), opens the device by its configured path | discover, import, degraded |
| E014 | `vdev_leaf` | `dev_labels` | `bio` | vdev_open() -> vdev_probe(): test reads of the pad area of labels 1 to 3 through the leaf before it counts as open; a failed probe faults the leaf | discover, import |
| E015 | `spa_load` | `ld_validate` | `ctl` | spa_ld_validate_vdevs() -> vdev_validate(), every leaf in parallel | discover, import |
| E016 | `dev_labels` | `ld_validate` | `cfg` | vdev_label_read_config(): vdev guid and top-level guid must match the config, the pool guid too once it is trusted; otherwise the leaf is CANT_OPEN | discover, import |
| E017 | `spa_load` | `ub_select` | `ctl` | spa_ld_select_uberblock(): find the uberblock to load | discover, import, uberblock, features, hostid_force, mmp, rewind, degraded, readonly, checkpoint |
| E018 | `dev_labels` | `ub_select` | `cfg` | vdev_uberblock_load(): every uberblock slot of every trusted label of every readable leaf; the best not above spa_load_max_txg wins (txg, then timestamp, then MMP sequence); then the label config for its txg from the same leaf | discover, import, uberblock, features, mmp, rewind, degraded, readonly, checkpoint |
| E019 | `ub_select` | `mmp_check` | `ctl` | spa_activity_check_required(): MMP in use in the uberblock and the pool not exported by this host: spa_ld_activity_check() | mmp |
| E020 | `dev_labels` | `mmp_check` | `cfg` | vdev_uberblock_load() again: about once a second during the tryimport check, after each claim write during import; a change in txg, timestamp or sequence means another host is writing | mmp |
| E021 | `mmp_check` | `ub_select` | `ctl` | verdict, also stored in the load information: no hostid on this system, activity seen or claim failed (EREMOTEIO), interrupted (EINTR), or inactive | mmp |
| E022 | `ub_select` | `ld_mos_open` | `bp` | version and features_for_read supported: spa_ld_open_rootbp() -> dsl_pool_init() opens the MOS at the uberblock's root block pointer | discover, import, uberblock, features, rewind, degraded, readonly, checkpoint |
| E023 | `ub_select` | `spa_load` | `ctl` | no valid uberblock (ENXIO), or an unsupported version or features_for_read entry (ENOTSUP, listed in ZPOOL_CONFIG_UNSUP_FEAT): the load fails | features |
| E024 | `dev_normal` | `ld_mos_open` | `zio` | dmu_objset_open_impl() reads the MOS objset block through the normal read path (arc_read()); every later phase reads MOS objects the same way | discover, import, uberblock |
| E025 | `spa_load` | `ld_trusted` | `cfg` | spa_ld_trusted_config(): load the config object from the MOS, rebuild the vdev tree from it with spa_config_parse(), copy the device paths from the provided config | discover, import, uberblock, features, mmp, rewind, degraded, readonly, checkpoint |
| E026 | `ld_trusted` | `vdev_open` | `ctl` | config trusted: spa_ld_open_vdevs() and spa_ld_validate_vdevs() again on the new tree; missing top-level vdevs now refuse a writeable import | discover, import, uberblock, degraded |
| E027 | `ld_trusted` | `spa_load` | `ctl` | the provided config missed SPA_SYNC_MIN_VDEVS or more top-level vdevs the MOS knows: EAGAIN, spa_ld_prepare_for_reload(), and the MOS init runs again with the trusted config | uberblock |
| E028 | `ld_trusted` | `mmp_check` | `ctl` | import (not tryimport, not extreme rewind) of a pool that needed the activity check: spa_activity_check_claim() | mmp |
| E029 | `mmp_check` | `dev_labels` | `bio` | mmp_claim_uberblock(): the best uberblock with a random MMP sequence to an MMP slot of every writeable leaf, then a cache flush; a leaf the config expects but that cannot be written fails the claim (ENODEV) | mmp |
| E030 | `ld_trusted` | `ld_logs` | `ctl` | spa_check_for_missing_logs(): an unopenable log device is ENXIO unless -m, which sets SPA_LOG_CLEAR | discover, import, degraded |
| E031 | `spa_load` | `ckpt_rewind` | `ctl` | --rewind-to-checkpoint: spa_ld_checkpoint_rewind() reads the checkpointed uberblock from the MOS directory and renumbers it above the current one | checkpoint |
| E032 | `ckpt_rewind` | `uberblock` | `cfg` | writeable import: vdev_config_sync(VDEV_CONFIG_REWINDING_CHECKPOINT) writes the checkpointed uberblock to the labels; from then on the rewind cannot be undone | checkpoint |
| E033 | `ckpt_rewind` | `spa_load` | `ctl` | spa_ld_prepare_for_reload(), then spa_ld_mos_with_trusted_config() again from the checkpointed uberblock | checkpoint |
| E034 | `spa_load` | `ld_features` | `cfg` | spa_ld_check_features(): features_for_read from the MOS, and features_for_write when writeable or a tryimport, checked by spa_features_check() | discover, import, features, readonly |
| E035 | `ld_features` | `spa_load` | `ctl` | an unknown feature: ENOTSUP with the list in ZPOOL_CONFIG_UNSUP_FEAT, plus ZPOOL_CONFIG_CAN_RDONLY when only write features are unknown | features |
| E036 | `spa_load` | `ld_meta` | `cfg` | special directories (dsl_pool_open()), pool properties, spares and cache devices, vdev metadata, dedup tables, BRT | discover, import, degraded, readonly |
| E037 | `spa_load` | `ld_logs` | `log` | spa_ld_verify_logs(): on a writeable import spa_check_logs() checks every dataset's log chain with zil_check_log_chain() | import |
| E038 | `spa_load` | `ld_verify` | `ctl` | spa_ld_verify_pool_data() -> spa_load_verify(), skipped for a tryimport | import, rewind, readonly |
| E039 | `ld_verify` | `dev_normal` | `zio` | traverse_pool() from spa_verify_min_txg: zio_read() at scrub priority of each metadata block (and data block when the count is reported) born after it | import, rewind, readonly |
| E040 | `ld_verify` | `spa_load` | `ctl` | more metadata errors than allowed (none by default; -M counts only critical metadata): EIO; otherwise the txg, its time and the error counts go into the load information | import, rewind, readonly |
| E041 | `spa_tryimport` | `ioc_pool` | `cfg` | spa_config_generate() from whatever loaded, plus pool state, uberblock timestamp and load information; then spa_unload() | discover, mmp, boot |
| E042 | `ioc_pool` | `libzfs_import` | `cfg` | the configuration comes back in zc_nvlist_dst, with ZPOOL_CONFIG_LOAD_INFO, even when the ioctl failed | discover, import, features, mmp, rewind, readonly, zil, boot |
| E043 | `libzfs_import` | `zpool_cmd` | `cfg` | refreshed configs back to zpool_do_import() through get_configs(); import_pools() lists each with show_import() (state, status from zpool_import_status(), action, vdev tree) or picks the one named | discover, import, mmp, boot |
| E044 | `zpool_cmd` | `force_check` | `cfg` | do_import(): an unsupported pool version is refused outright, then zfs_force_import_required() on the tryimport config | import, hostid_force, mmp, boot |
| E045 | `force_check` | `zpool_cmd` | `ctl` | without -f: refused if the pool was not exported and its hostid differs from get_system_hostid() ("previously in use from another system"), or tryimport saw MMP activity or no hostid | hostid_force, mmp |
| E046 | `zpool_cmd` | `libzfs_import` | `cfg` | zpool_import_props(): new name checked, -o properties validated by zpool_valid_proplist() | import, hostid_force, mmp, readonly, boot |
| E047 | `libzfs_import` | `ioc_pool` | `cfg` | ZFS_IOC_POOL_IMPORT with the tryimport config and its load policy, the properties, and the import flags in zc_cookie | import, hostid_force, mmp, readonly, boot |
| E048 | `ioc_pool` | `spa_import` | `cfg` | zfs_ioc_pool_import(): the config's pool guid must equal zc_guid, then spa_import() | import, hostid_force, mmp, readonly, boot |
| E049 | `spa_import` | `spa_ns` | `ctl` | spa_lookup(): a pool of that name already imported is EEXIST; spa_add() | import |
| E050 | `spa_import` | `load_best` | `ctl` | spa_activate() (SPA_MODE_READ with readonly=on), spa_async_suspend(), spa_load_best() in state IMPORT, or RECOVER with -F | import, hostid_force, mmp, rewind, degraded, readonly, checkpoint |
| E051 | `load_best` | `spa_load` | `ctl` | spa_load() with spa_load_max_txg unlimited, or the txg given with -T | import, hostid_force, mmp, rewind, degraded, readonly, checkpoint |
| E052 | `spa_load` | `load_best` | `ctl` | spa_load_impl() result; a failure other than EREMOTEIO, EBADF, EINTR or a missing checkpoint starts the rewind search | import, features, hostid_force, rewind, degraded, readonly, zil, async_work |
| E053 | `load_best` | `spa_load` | `ctl` | spa_load_retry(): unload, spa_load_max_txg = the failed uberblock's txg - 1, spa_load() again; continues down to the newest txg - TXG_DEFER_SIZE, or TXG_INITIAL with -X | rewind |
| E054 | `load_best` | `spa_import` | `ctl` | result: 0 when a load succeeded (with -F possibly at an older txg); otherwise the first error, with what a rewind would reach in ZPOOL_CONFIG_REWIND_INFO | import, features, hostid_force, rewind, degraded, readonly, zil, async_work |
| E055 | `spa_import` | `ioc_pool` | `cfg` | spa_load_info (rewind info, missing devices, MMP state, unsupported features) added to the config for userspace; on failure spa_unload(), spa_remove() | import, features, rewind, readonly, zil, boot |
| E056 | `libzfs_import` | `zpool_cmd` | `ctl` | failure explained: unsupported features (and whether readonly=on works), the host holding the pool, missing log devices (use -m), or zpool_explain_recover() suggesting -F | features, rewind, boot |
| E057 | `libzfs_import` | `zpool_cmd` | `ctl` | success; after -F or -nF, zpool_rewind_exclaim() reports the state returned to and the transactions discarded | import, rewind, readonly, zil, boot |
| E058 | `spa_load` | `zil_replay` | `log` | writeable load: spa_ld_claim_log_blocks(): one tx in the first txg, dmu_objset_find_dp(zil_claim) over every dataset; zil_claim_log_block() -> zio_claim(), or the chain is freed when the log state is SPA_LOG_CLEAR | import, rewind, degraded, zil, checkpoint |
| E059 | `dev_slog` | `zil_replay` | `log` | zil_parse() -> zil_read_log_block(): the log chain block by block from the SLOG, or from the main pool when there is none | import, zil |
| E060 | `spa_load` | `txg_sync` | `tx` | spa_sync_on, txg_sync_start(); then txg_wait_synced(spa_claim_max_txg) so the claims are on disk | import, uberblock, mmp, rewind, degraded, zil, checkpoint |
| E061 | `spa_load` | `mmp` | `ctl` | mmp_thread_start(): the heartbeat thread starts with the pool | import, mmp |
| E062 | `spa_load` | `resilver_start` | `ctl` | vdev_rebuild_active() -> vdev_rebuild_restart(); else, with no resilver running, vdev_resilver_needed() looks for a non-empty DTL | import, async_work |
| E063 | `resilver_start` | `spa_async` | `ctl` | spa_async_request(SPA_ASYNC_RESILVER) | async_work |
| E064 | `spa_async` | `resilver_start` | `ctl` | spa_async_thread(): dsl_scan_restart_resilver(), unless a rebuild is active or (with resilver_defer) a resilver already runs | async_work |
| E065 | `spa_load` | `spa_async` | `ctl` | spa_ld_check_for_config_update() requests SPA_ASYNC_CONFIG_UPDATE (always after an import or a rewind); also SPA_ASYNC_DEFER_DESTROY and SPA_ASYNC_L2CACHE_REBUILD | import, async_work |
| E066 | `spa_import` | `spa_async` | `ctl` | spa_async_resume(); spa_async_request(SPA_ASYNC_AUTOEXPAND): with autoexpand=on spa_async_autoexpand() posts an event for each leaf with a physical path | import, async_work |
| E067 | `spa_sync` | `spa_async` | `ctl` | spa_async_dispatch() at the end of spa_sync() starts spa_async_thread() when requests are pending and async work is not suspended | async_work |
| E068 | `spa_import` | `cachefile` | `ctl` | writeable import: spa_config_update(SPA_CONFIG_UPDATE_POOL) | import, hostid_force |
| E069 | `spa_async` | `cachefile` | `ctl` | SPA_ASYNC_CONFIG_UPDATE: spa_config_update(SPA_CONFIG_UPDATE_POOL) | async_work |
| E070 | `cachefile` | `txg_sync` | `tx` | vdev_config_dirty(root), then txg_wait_synced(): that txg rewrites every label with the state ACTIVE and this host's hostid and hostname | import, hostid_force, async_work |
| E071 | `cachefile` | `zpool_cache` | `cfg` | spa_write_cachefile() -> spa_config_write(): every writeable pool using this cachefile, packed, written in place and fsynced | import, export, async_work |
| E072 | `txg_sync` | `spa_sync` | `tx` | txg_sync_thread() -> spa_sync(txg) | import, uberblock, hostid_force, rewind, zil, export, async_work |
| E073 | `spa_sync` | `uberblock` | `cfg` | spa_sync_rewrite_vdev_config() -> vdev_config_sync(): every vdev when the config is dirty, otherwise a few top-level vdevs chosen by spa_select_uberblock_vdevs() | import, uberblock, hostid_force, mmp_heartbeat, rewind, export |
| E074 | `uberblock` | `vdev_label` | `cfg` | vdev_label_sync_list() even labels, vdev_uberblock_sync_list() the new uberblock, vdev_label_sync_list() odd labels | import, uberblock, hostid_force, rewind, export, checkpoint |
| E075 | `vdev_label` | `dev_labels` | `bio` | vdev_label_sync() and vdev_uberblock_sync() -> vdev_label_write(): config nvlist and uberblock at fixed offsets in L0-L3 | import, uberblock, hostid_force, rewind, export, checkpoint |
| E076 | `uberblock` | `mmp` | `ctl` | multihost=on: mmp_update_uberblock() gives the MMP thread each newly synced uberblock | mmp_heartbeat |
| E077 | `mmp` | `dev_labels` | `bio` | mmp_write_uberblock(): the last synced uberblock with a new timestamp and sequence to a random MMP slot of a random label on the next leaf (mmp_next_leaf()) | mmp, mmp_heartbeat |
| E078 | `mmp` | `suspend` | `ctl` | no MMP write succeeded for zfs_multihost_fail_intervals x zfs_multihost_interval: zio_suspend(ZIO_SUSPEND_MMP) | mmp_heartbeat |
| E079 | `zpool_cmd` | `mount_lib` | `ctl` | do_import(): unless -N or the pool is UNAVAIL, zpool_enable_datasets() mounts every file system with zfs_foreach_mountpoint(), then shares them | import, readonly, zil |
| E080 | `mount_lib` | `zpl_mount` | `ctl` | zfs_mount_one() -> zfs_mount() -> zfs_mount_at() -> do_mount() -> mount(2) -> zpl_get_tree() -> zfs_domount() | import, readonly, zil |
| E081 | `zpl_mount` | `zil_replay` | `log` | zfsvfs_setup(): zil_open(), then on a writeable pool zil_replay() (with zil_replay_disable the log is destroyed instead) | import, zil |
| E082 | `zil_replay` | `txg_sync` | `tx` | each claimed record is re-executed as a normal transaction by zil_replay_log_record(); then zil_destroy() and txg_wait_synced() until the empty log is on disk | zil |
| E083 | `zpool_cmd` | `mount_lib` | `ctl` | zpool export: zpool_export_one() -> zpool_disable_datasets(): the pool's file systems from the mount table, unshared, then unmounted (-f forces) | export |
| E084 | `mount_lib` | `vfs_umount` | `ctl` | unmount_one() -> do_unmount() -> umount2(2) -> zfs_umount(): zfsvfs_teardown() closes the ZIL, the dataset is disowned | export |
| E085 | `zpool_cmd` | `libzfs_export` | `ctl` | zpool_export(), or zpool_export_force() with -F; with -a every pool on a taskq (zpool_export_one_async()) | export |
| E086 | `libzfs_export` | `ioc_pool` | `ctl` | zpool_export_common(): ZFS_IOC_POOL_EXPORT, zc_cookie = force, zc_guid = hardforce | export |
| E087 | `ioc_pool` | `spa_export` | `ctl` | zfs_ioc_pool_export() -> spa_export() -> spa_export_common(POOL_STATE_EXPORTED) | export |
| E088 | `spa_export` | `spa_ns` | `ctl` | spa_lookup(); spa_is_exporting set, so a second export gets ZFS_ERR_EXPORT_IN_PROGRESS | export |
| E089 | `spa_export` | `spa_async` | `ctl` | spa_async_suspend(): waits for a running async thread and keeps new ones from starting | export |
| E090 | `spa_export` | `txg_sync` | `tx` | txg_wait_synced(), then spa_evicting_os_wait(): objsets held only by dirty data or still being evicted let go before the reference check | export |
| E091 | `spa_export` | `libzfs_export` | `ctl` | refused, the pool stays imported: EBUSY while anything still holds it (for example an open zvol), EXDEV for an active shared spare unless -f | export |
| E092 | `spa_export` | `spa_unload` | `ctl` | zvol_remove_minors(), initialize and TRIM stopped; unless -F spa_state = POOL_STATE_EXPORTED, vdev_config_dirty(root) and spa_final_txg set; then spa_unload() | export |
| E093 | `spa_unload` | `txg_sync` | `tx` | txg_sync_stop(): txg_wait_synced() up to the open txg + TXG_DEFER_SIZE, then the sync threads exit; these last txgs carry the dirty labels | export |
| E094 | `spa_unload` | `mmp` | `ctl` | mmp_thread_stop() | export |
| E095 | `spa_unload` | `vdev_leaf` | `ctl` | vdev_free(root) -> vdev_close(): every leaf device released; then dsl_pool_close() | export |
| E096 | `spa_export` | `cachefile` | `ctl` | unless -F: spa_write_cachefile() with removing set, so the cachefile is rewritten without this pool | export |
| E097 | `spa_export` | `spa_ns` | `ctl` | spa_remove(): the pool leaves the namespace; spa_namespace_broadcast() wakes lookups that waited for the export | export |
| E098 | `boot_import` | `zpool_cmd` | `ctl` | zfs-import-cache.service: zpool import -c /etc/zfs/zpool.cache -aN, or zfs-import-scan.service: zpool import -aN -o cachefile=none | boot |
| E099 | `libzutil_search` | `cache_read` | `ctl` | -c given: zpool_find_import_cached() instead of a device search | boot |
| E100 | `zpool_cache` | `cache_read` | `cfg` | the file read whole and nvlist_unpack()ed: one config per pool; pools already imported are skipped (zutil_pool_active()) | boot |
| E101 | `cache_read` | `libzfs_import` | `cfg` | each cached config, tagged with ZPOOL_CONFIG_CACHEFILE, goes straight to zutil_refresh_config(); the kernel then allows up to zfs_max_missing_tvds_cachefile missing top-level vdevs in it | boot |
| E102 | `cache_read` | `dev_scan` | `ctl` | fallback scan: discover_cached_paths() -> zpool_find_import_scan_dir() for each directory that holds a device path in the cachefile, then zpool_find_import_impl() for that pool's guid | boot |
| E103 | `admin` | `zpool_cmd` | `ctl` | runs zpool import (no name: list importable pools; with a name or -a: import), with -d, -c, -f, -F, -X, -N or -o readonly=on | discover, import, hostid_force, readonly |
| E104 | `admin` | `zpool_cmd` | `ctl` | runs zpool export [-f] [-F] pool (or -a) | export |

## 10. Paths

15 named paths, 320 steps in total. Each step is one wire; the caption for a step is that wire's label. Every wire in section 9 is on at least one path. The category is the heading the path is listed under in the left panel. Path syntax, alternatives and notes are defined in section 10 of `../zfs-io-flow-diagram-spec.md`.

### 10.1 `discover` - zpool import: listing importable pools

Category: Discovery. `zpool import` with no pool name. Userspace reads the labels of every candidate device and assembles one configuration per pool; the kernel test-loads each read-only and reports what it found. Nothing is written anywhere.

Alternatives:
- `src`: `blkid` default: devices libblkid knows as zfs_member; `dirs` -d directories, ZPOOL_IMPORT_PATH, or -s (default search path)

```
 1  E103  admin -> zpool_cmd
 2  E001  zpool_cmd -> libzutil_search
 3  E002  libzutil_search -> dev_scan  [src: blkid]  "zpool_find_import_blkid(): every device with TYPE=zfs_member, ranked by zfs_path_order()"
 4  E002  libzutil_search -> dev_scan  [src: dirs]  "zpool_find_import_scan(): every entry of each directory, ranked by directory order"
 5  E003  libzutil_search -> label_read_user
 6  E004  dev_labels -> label_read_user
 7  E005  label_read_user -> get_configs
 8  E006  get_configs -> libzfs_import
 9  E007  libzfs_import -> ioc_pool
10  E008  ioc_pool -> spa_tryimport
11  E009  spa_tryimport -> spa_ns
12  E010  spa_tryimport -> spa_load
13  E011  spa_load -> ld_parse
14  E012  spa_load -> vdev_open  "config source SPA_CONFIG_SRC_SCAN: zfs_max_missing_tvds_scan (0) missing top-level vdevs allowed at this stage"
15  E013  vdev_open -> vdev_leaf
16  E014  vdev_leaf -> dev_labels
17  E015  spa_load -> ld_validate
18  E016  dev_labels -> ld_validate
19  E017  spa_load -> ub_select
20  E018  dev_labels -> ub_select
21  E022  ub_select -> ld_mos_open
22  E024  dev_normal -> ld_mos_open
23  E025  spa_load -> ld_trusted
24  E026  ld_trusted -> vdev_open
25  E030  ld_trusted -> ld_logs  "tryimport always runs with ZFS_IMPORT_MISSING_LOG: a missing log device only drops the log here"
26  E034  spa_load -> ld_features  "for a tryimport the write features are checked too, to tell userspace whether readonly=on would be needed"
27  E036  spa_load -> ld_meta
28  E041  spa_tryimport -> ioc_pool
29  E042  ioc_pool -> libzfs_import
30  E043  libzfs_import -> zpool_cmd
```
Ends: Each pool found is printed with its name, id, state, status and vdev tree, or "no pools available to import". The temporary pool is unloaded and removed; no device was written. A pool with `multihost=on` also runs the activity check here (path `mmp`).

### 10.2 `import` - zpool import <pool>: a normal import

Category: Import. Import by name (or numeric id). After the search and tryimport of path `discover`, zpool(8) checks the host, the kernel loads the pool for real, and a writeable load ends by claiming the logs, starting the sync thread and rewriting labels and cachefile. Then the file systems are mounted.

Alternatives:
- `mnt`: `mount` mount and share the file systems; `noimport` -N: import only, mount nothing

```
 1  E103  admin -> zpool_cmd
 2  E001  zpool_cmd -> libzutil_search  "with a name, only labels of that pool are kept; search and tryimport run as in path discover"
 3  E043  libzfs_import -> zpool_cmd
 4  E044  zpool_cmd -> force_check
 5  E046  zpool_cmd -> libzfs_import
 6  E047  libzfs_import -> ioc_pool
 7  E048  ioc_pool -> spa_import
 8  E049  spa_import -> spa_ns
 9  E050  spa_import -> load_best
10  E051  load_best -> spa_load
11  E011  spa_load -> ld_parse
12  E012  spa_load -> vdev_open  "config source SPA_CONFIG_SRC_TRYIMPORT: no missing top-level vdev beyond zfs_max_missing_tvds"
13  E013  vdev_open -> vdev_leaf
14  E014  vdev_leaf -> dev_labels
15  E015  spa_load -> ld_validate
16  E016  dev_labels -> ld_validate
17  E017  spa_load -> ub_select
18  E018  dev_labels -> ub_select
19  E022  ub_select -> ld_mos_open
20  E024  dev_normal -> ld_mos_open
21  E025  spa_load -> ld_trusted
22  E026  ld_trusted -> vdev_open
23  E030  ld_trusted -> ld_logs
24  E034  spa_load -> ld_features
25  E036  spa_load -> ld_meta
26  E037  spa_load -> ld_logs
27  E038  spa_load -> ld_verify
28  E039  ld_verify -> dev_normal
29  E040  ld_verify -> spa_load
30  E058  spa_load -> zil_replay
31  E059  dev_slog -> zil_replay
32  E060  spa_load -> txg_sync
33  E061  spa_load -> mmp
34  E062  spa_load -> resilver_start
35  E065  spa_load -> spa_async
36  E052  spa_load -> load_best
37  E054  load_best -> spa_import
38  E068  spa_import -> cachefile
39  E070  cachefile -> txg_sync
40  E072  txg_sync -> spa_sync
41  E073  spa_sync -> uberblock
42  E074  uberblock -> vdev_label
43  E075  vdev_label -> dev_labels
44  E071  cachefile -> zpool_cache
45  E066  spa_import -> spa_async
46  E055  spa_import -> ioc_pool
47  E042  ioc_pool -> libzfs_import
48  E057  libzfs_import -> zpool_cmd
49  E079  zpool_cmd -> mount_lib  [mnt: mount]
50  E080  mount_lib -> zpl_mount  [mnt: mount]
51  E081  zpl_mount -> zil_replay  [mnt: mount]
```
Ends: The pool is in the namespace and syncing. Every label says ACTIVE with this host's hostid, the cachefile lists the pool, and any resilver or config update runs from the async thread. With `-N` nothing is mounted and the claimed log records wait for the first mount (`zfs mount`); the replay itself is path `zil`.

### 10.3 `uberblock` - Which state is loaded: uberblock selection

Category: Import. The heart of every import: the best uberblock on any readable device decides the txg the pool returns to, and its root block pointer opens the MOS. If the userspace config missed devices that the MOS knows about, the selection is repeated with the trusted config.

Alternatives:
- `cfg`: `match` the provided config has every top-level vdev; `reload` the provided config missed top-level vdevs the MOS lists

```
 1  E017  spa_load -> ub_select
 2  E018  dev_labels -> ub_select  "each sync writes its uberblock to slot txg modulo the ring size in all four labels of the chosen leaves, so the rings hold the latest txgs"
 3  E022  ub_select -> ld_mos_open  "dsl_pool_init() at the first txg: the pool continues right after the loaded txg"
 4  E024  dev_normal -> ld_mos_open
 5  E025  spa_load -> ld_trusted
 6  E026  ld_trusted -> vdev_open
 7  E027  ld_trusted -> spa_load  [cfg: reload]
 8  E017  spa_load -> ub_select  [cfg: reload]  "second pass with every top-level vdev of the MOS config open"
 9  E018  dev_labels -> ub_select  [cfg: reload]  "a newer uberblock that lived only on the missed vdevs is found now"
10  E022  ub_select -> ld_mos_open  [cfg: reload]
11  E025  spa_load -> ld_trusted  [cfg: reload]
12  E060  spa_load -> txg_sync  "writeable import: the first txg is the loaded txg + 1"
13  E072  txg_sync -> spa_sync
14  E073  spa_sync -> uberblock
15  E074  uberblock -> vdev_label
16  E075  vdev_label -> dev_labels  "the first new uberblock overwrites the ring slot of an older txg"
```
Ends: The pool runs from the loaded txg. Once newer txgs are synced, older uberblocks are overwritten slot by slot, which is why `-F` can only go back a limited number of txgs. The commit itself is `zfs-io-flow:txg_sync`.

### 10.4 `features` - Refused: unsupported feature flags

Category: Refusals. A pool that uses a feature this software does not implement. Features needed to read the pool are listed in the label and refuse the import before the MOS is opened; features needed only to write are found in the MOS and refuse only a writeable import.

Alternatives:
- `feat`: `read` an unknown feature in features_for_read; `write` only features_for_write are unknown

```
 1  E017  spa_load -> ub_select
 2  E018  dev_labels -> ub_select
 3  E023  ub_select -> spa_load  [feat: read]  "the label of the best uberblock lists a feature for read that zfeature_is_supported() does not know"
 4  E022  ub_select -> ld_mos_open  [feat: write]
 5  E025  spa_load -> ld_trusted  [feat: write]
 6  E034  spa_load -> ld_features  [feat: write]
 7  E035  ld_features -> spa_load  [feat: write]
 8  E052  spa_load -> load_best
 9  E054  load_best -> spa_import
10  E055  spa_import -> ioc_pool
11  E042  ioc_pool -> libzfs_import
12  E056  libzfs_import -> zpool_cmd  "'This pool uses the following feature(s) not supported by this system'; for write-only features also 'The pool can be imported using -o readonly=on'"
```
Ends: The import is refused with the list of features. With only write features unknown, `zpool import -o readonly=on` succeeds (path `readonly`).

### 10.5 `hostid_force` - Last used by another host: the -f check

Category: Refusals. A pool with `multihost=off` that was not exported and whose hostid is not this host's, for example after the other host crashed or when a disk is moved without `zpool export`. Only zpool(8) checks this; the kernel imports whatever it is sent.

Alternatives:
- `f`: `nof` zpool import <pool>; `f` zpool import -f <pool>

```
 1  E103  admin -> zpool_cmd
 2  E044  zpool_cmd -> force_check  "the hostid comes from the MOS config (ZPOOL_CONFIG_LOAD_INFO of the tryimport), or the label hostid for an older kernel"
 3  E045  force_check -> zpool_cmd  [f: nof]  "'cannot import: pool was previously in use from another system', with the last host name, hostid and time"
 4  E046  zpool_cmd -> libzfs_import  [f: f]
 5  E047  libzfs_import -> ioc_pool  [f: f]  "ZFS_IMPORT_ANY_HOST travels in zc_cookie, but the kernel never tests it"
 6  E048  ioc_pool -> spa_import  [f: f]
 7  E050  spa_import -> load_best  [f: f]
 8  E051  load_best -> spa_load  [f: f]
 9  E017  spa_load -> ub_select  [f: f]  "multihost=off: spa_activity_check_required() finds MMP unused in the uberblock and skips the check"
10  E052  spa_load -> load_best  [f: f]
11  E054  load_best -> spa_import  [f: f]
12  E068  spa_import -> cachefile  [f: f]
13  E070  cachefile -> txg_sync  [f: f]  "the labels now carry this host's hostid: the other host would in turn need -f"
14  E072  txg_sync -> spa_sync  [f: f]
15  E073  spa_sync -> uberblock  [f: f]
16  E074  uberblock -> vdev_label  [f: f]
17  E075  vdev_label -> dev_labels  [f: f]
```
Ends: Without `-f` nothing reached the kernel. With `-f` the pool is imported and now belongs to this host. If the other host still has the pool imported, both write to it and the pool is damaged: this is what `multihost=on` prevents (path `mmp`).

### 10.6 `mmp` - multihost=on: activity check and claim

Category: Refusals. With `multihost=on` the host that has the pool imported keeps writing MMP uberblocks. An importing host watches the label rings for those writes during tryimport, and during the import writes its own claim and checks that it stays the best. `-f` changes nothing here.

Alternatives:
- `other`: `idle` the other host is gone (crashed or powered off); `active` the other host still has the pool imported

```
 1  E010  spa_tryimport -> spa_load  "every zpool import first runs a tryimport, as in path discover"
 2  E017  spa_load -> ub_select
 3  E018  dev_labels -> ub_select
 4  E019  ub_select -> mmp_check  "not exported by this host: the check is required; a system with no hostid is refused here"
 5  E020  dev_labels -> mmp_check  "tryimport: watch for MMP_FAIL_INT x MMP_INTERVAL x 2 from the uberblock (20 s with defaults), plus up to 25%"
 6  E077  mmp -> dev_labels  [other: active]  "meanwhile the owning host's heartbeat lands in the rings"
 7  E021  mmp_check -> ub_select
 8  E041  spa_tryimport -> ioc_pool
 9  E042  ioc_pool -> libzfs_import
10  E043  libzfs_import -> zpool_cmd
11  E044  zpool_cmd -> force_check
12  E045  force_check -> zpool_cmd  [other: active]  "'pool is imported on <host> (hostid ...)': refused; with -f the kernel refuses the same way with EREMOTEIO"
13  E046  zpool_cmd -> libzfs_import  [other: idle]
14  E047  libzfs_import -> ioc_pool  [other: idle]
15  E048  ioc_pool -> spa_import  [other: idle]
16  E050  spa_import -> load_best  [other: idle]
17  E051  load_best -> spa_load  [other: idle]
18  E017  spa_load -> ub_select  [other: idle]
19  E019  ub_select -> mmp_check  [other: idle]  "import: spa_activity_verify_config(): the uberblock is the one tryimport watched, so no second wait"
20  E021  mmp_check -> ub_select  [other: idle]
21  E025  spa_load -> ld_trusted  [other: idle]
22  E028  ld_trusted -> mmp_check  [other: idle]
23  E029  mmp_check -> dev_labels  [other: idle]  "ten rounds, one MMP interval apart (about 10 s with defaults)"
24  E020  dev_labels -> mmp_check  [other: idle]  "after each write the best uberblock must still be this host's claim"
25  E060  spa_load -> txg_sync  [other: idle]
26  E061  spa_load -> mmp  [other: idle]
27  E077  mmp -> dev_labels  [other: idle]  "now this host's heartbeat"
```
Ends: Active: the import is refused and nothing was written. Idle: the pool is imported after roughly 30 s of checks and this host's MMP thread now protects it (path `mmp_heartbeat`).

### 10.7 `mmp_heartbeat` - multihost=on: the owner's heartbeat

Category: Refusals. What the importing host is watching for. While the pool is imported with `multihost=on`, the MMP thread writes a fresh copy of the last synced uberblock to some leaf several times per interval. If those writes stop landing, the owner suspends the pool before an importer's check can conclude that it is gone.

Alternatives:
- `w`: `ok` writes land; `fail` no write succeeds for zfs_multihost_fail_intervals intervals

```
 1  E073  spa_sync -> uberblock
 2  E076  uberblock -> mmp
 3  E077  mmp -> dev_labels
 4  E078  mmp -> suspend  [w: fail]
```
Ends: With writes landing, any importing host sees activity within its check. Without, the pool is suspended (`zfs-fault-management:suspend_clear`), and `zpool clear` resumes it only after verifying that no other host imported it in the meantime.

### 10.8 `rewind` - zpool import -F, -nF, -FX: returning to an older txg

Category: Recovery. The newest txg cannot be loaded, here because `spa_load_verify()` finds damaged metadata in it. The rewind search loads again below each failed uberblock. With `-F` the first good older txg becomes the pool and the newer txgs and the intent logs are lost; `-X` may go back further and verifies the whole pool; `-n` and a plain import only report.

Alternatives:
- `mode`: `F` -F: rewind within the last TXG_DEFER_SIZE txgs; `n` -nF: report what -F would do; `X` -FX: extreme rewind, back to TXG_INITIAL; `plain` no -F: the import fails

```
 1  E050  spa_import -> load_best  "-F sets state SPA_LOAD_RECOVER; -nF and a plain import stay in SPA_LOAD_IMPORT"
 2  E051  load_best -> spa_load
 3  E017  spa_load -> ub_select
 4  E018  dev_labels -> ub_select
 5  E022  ub_select -> ld_mos_open
 6  E025  spa_load -> ld_trusted
 7  E038  spa_load -> ld_verify
 8  E039  ld_verify -> dev_normal
 9  E040  ld_verify -> spa_load  "the newest txg has a metadata error: EIO"
10  E052  spa_load -> load_best
11  E053  load_best -> spa_load
12  E017  spa_load -> ub_select  "the best uberblock below the failed one: an older txg still in the rings"
13  E018  dev_labels -> ub_select
14  E022  ub_select -> ld_mos_open
15  E025  spa_load -> ld_trusted
16  E038  spa_load -> ld_verify
17  E039  ld_verify -> dev_normal  [mode: F, n, plain]  "from the loaded txg - TXG_DEFER_SIZE - 1; -nF also reads data blocks to report the data error count"
18  E039  ld_verify -> dev_normal  [mode: X]  "extreme rewind: from TXG_INITIAL - 1, the whole pool; this can take very long"
19  E040  ld_verify -> spa_load
20  E058  spa_load -> zil_replay  [mode: F, X]  "SPA_LOG_CLEAR: every intent log is discarded instead of claimed"
21  E060  spa_load -> txg_sync  [mode: F, X]  "first txg numbered above the newest uberblock on disk, so the discarded txgs can never be selected again"
22  E072  txg_sync -> spa_sync  [mode: F, X]
23  E073  spa_sync -> uberblock  [mode: F, X]
24  E074  uberblock -> vdev_label  [mode: F, X]
25  E075  vdev_label -> dev_labels  [mode: F, X]
26  E052  spa_load -> load_best  [mode: n, plain]  "a load below the newest txg outside RECOVER skips every write, so it can only report"
27  E054  load_best -> spa_import
28  E055  spa_import -> ioc_pool
29  E042  ioc_pool -> libzfs_import
30  E056  libzfs_import -> zpool_cmd  [mode: plain]  "'Recovery is possible, but will result in some data loss ... by executing zpool import -F'"
31  E057  libzfs_import -> zpool_cmd  [mode: F, X]  "'Pool returned to its state as of ...', with the time discarded"
32  E056  libzfs_import -> zpool_cmd  [mode: n]  "'Would be able to return ... to its state as of ...', with the time that would be discarded"
```
Ends: `-F` and `-FX`: the pool runs from the older txg; later txgs and every synchronous write still in the intent log are gone, and a scrub is advised. `-nF` and a plain import: nothing was written and the pool is not imported.

### 10.9 `degraded` - Importing with devices missing

Category: Recovery. Some devices of the pool are absent. Redundancy decides: a missing mirror side or raidz child within parity leaves the pool DEGRADED but importable; a missing log device needs `-m`; a missing top-level vdev can only be imported read-only, after raising zfs_max_missing_tvds.

Alternatives:
- `miss`: `leg` a mirror side or raidz child; `log` a log device, imported with -m; `tvd` a whole top-level vdev, with zfs_max_missing_tvds and -o readonly=on

```
 1  E050  spa_import -> load_best
 2  E051  load_best -> spa_load
 3  E012  spa_load -> vdev_open
 4  E013  vdev_open -> vdev_leaf  "the absent device fails to open and its leaf is CANT_OPEN"
 5  E017  spa_load -> ub_select
 6  E018  dev_labels -> ub_select  "only the leaves that opened are read"
 7  E022  ub_select -> ld_mos_open
 8  E025  spa_load -> ld_trusted
 9  E026  ld_trusted -> vdev_open  "a missing top-level vdev under the trusted config: ENXIO for a writeable import, accepted read-only up to zfs_max_missing_tvds"
10  E030  ld_trusted -> ld_logs  [miss: log]  "-m given: the log is dropped (SPA_LOG_CLEAR); without -m the import would fail here and libzfs would list the missing log device"
11  E036  spa_load -> ld_meta  [miss: tvd]  "spa_ld_get_props() forces failmode=continue"
12  E058  spa_load -> zil_replay  [miss: log]  "the logs are cleared, not claimed: the last synchronous writes are lost"
13  E060  spa_load -> txg_sync  [miss: leg, log]
14  E052  spa_load -> load_best
15  E054  load_best -> spa_import
```
Ends: `leg`: the pool is DEGRADED and writable; writes the missing device misses are recorded in its DTL and resilvered when it comes back (`zfs-fault-management:device_removed`). `log`: imported without the log device or its records. `tvd`: imported read-only with failmode=continue; data on the missing vdev is unreadable.

### 10.10 `readonly` - zpool import -o readonly=on

Category: Import. A read-only import loads the pool exactly like a normal one but stops before every step that writes: no log claim, no sync thread, no MMP heartbeat, no label or cachefile update. It also accepts a pool whose unknown features are needed only for writing.

```
 1  E103  admin -> zpool_cmd
 2  E046  zpool_cmd -> libzfs_import
 3  E047  libzfs_import -> ioc_pool
 4  E048  ioc_pool -> spa_import
 5  E050  spa_import -> load_best  "readonly=on in the properties: spa_activate(SPA_MODE_READ)"
 6  E051  load_best -> spa_load
 7  E017  spa_load -> ub_select
 8  E018  dev_labels -> ub_select
 9  E022  ub_select -> ld_mos_open
10  E025  spa_load -> ld_trusted
11  E034  spa_load -> ld_features  "features_for_write are not checked"
12  E036  spa_load -> ld_meta
13  E038  spa_load -> ld_verify
14  E039  ld_verify -> dev_normal
15  E040  ld_verify -> spa_load
16  E052  spa_load -> load_best  "not writeable: the claim, sync start, config update and resilver steps of spa_load_impl() are skipped"
17  E054  load_best -> spa_import  "spa_prop_set() and spa_config_update() are skipped: labels and cachefile stay as they were"
18  E055  spa_import -> ioc_pool
19  E042  ioc_pool -> libzfs_import
20  E057  libzfs_import -> zpool_cmd
21  E079  zpool_cmd -> mount_lib
22  E080  mount_lib -> zpl_mount  "zfsvfs_setup() opens the ZIL but does not replay it on a read-only pool"
```
Ends: The pool is imported read-only. The labels still show the state and host of the last writeable import, the intent logs are untouched for a later read-write import, and an export writes nothing to the labels because no sync thread runs.

### 10.11 `zil` - Intent logs: claimed at import, replayed at mount

Category: After import. Synchronous writes that reached the intent log but not a synced txg survive an unclean shutdown only in the log chains. Import claims their blocks so nothing overwrites them; each file system replays its own log when it is mounted.

```
 1  E058  spa_load -> zil_replay
 2  E059  dev_slog -> zil_replay  "claim: log blocks born after the last synced txg are claimed; zil_claim() marks the header ZIL_REPLAY_NEEDED"
 3  E060  spa_load -> txg_sync  "txg_wait_synced(spa_claim_max_txg): the claims are synced before the import returns"
 4  E072  txg_sync -> spa_sync
 5  E052  spa_load -> load_best
 6  E054  load_best -> spa_import
 7  E055  spa_import -> ioc_pool
 8  E042  ioc_pool -> libzfs_import
 9  E057  libzfs_import -> zpool_cmd
10  E079  zpool_cmd -> mount_lib
11  E080  mount_lib -> zpl_mount
12  E081  zpl_mount -> zil_replay
13  E059  dev_slog -> zil_replay  "replay: the claimed chain is read again and each record re-executed"
14  E082  zil_replay -> txg_sync
```
Ends: The file system is mounted with every logged synchronous write applied; the log is empty. The replay of one write record is `zfs-io-flow:crash_replay`.

### 10.12 `boot` - Boot: import from the cachefile

Category: Boot. At boot the import service imports every pool in /etc/zfs/zpool.cache without scanning devices and without mounting. If that import fails, zpool(8) retries once by scanning only the directories the cachefile's device paths are in.

Alternatives:
- `res`: `ok` the cached configs import; `fallback` the cachefile import fails and is retried by scanning

```
 1  E098  boot_import -> zpool_cmd
 2  E001  zpool_cmd -> libzutil_search
 3  E099  libzutil_search -> cache_read
 4  E100  zpool_cache -> cache_read
 5  E101  cache_read -> libzfs_import
 6  E007  libzfs_import -> ioc_pool
 7  E008  ioc_pool -> spa_tryimport
 8  E010  spa_tryimport -> spa_load  "config source SPA_CONFIG_SRC_CACHEFILE: up to zfs_max_missing_tvds_cachefile (2) top-level vdevs may be missing from the cached config"
 9  E041  spa_tryimport -> ioc_pool
10  E042  ioc_pool -> libzfs_import
11  E043  libzfs_import -> zpool_cmd  "-a: each pool is imported by do_import_task() on a taskq"
12  E044  zpool_cmd -> force_check
13  E046  zpool_cmd -> libzfs_import
14  E047  libzfs_import -> ioc_pool
15  E048  ioc_pool -> spa_import  "the kernel load runs as in path import"
16  E055  spa_import -> ioc_pool
17  E042  ioc_pool -> libzfs_import
18  E057  libzfs_import -> zpool_cmd  [res: ok]
19  E056  libzfs_import -> zpool_cmd  [res: fallback]  "'cachefile import failed, retrying'"
20  E001  zpool_cmd -> libzutil_search  [res: fallback]  "zpool_search_import() again with scan set"
21  E099  libzutil_search -> cache_read  [res: fallback]
22  E102  cache_read -> dev_scan  [res: fallback]
23  E003  libzutil_search -> label_read_user  [res: fallback]
24  E004  dev_labels -> label_read_user  [res: fallback]
25  E005  label_read_user -> get_configs  [res: fallback]
26  E006  get_configs -> libzfs_import  [res: fallback]
27  E046  zpool_cmd -> libzfs_import  [res: fallback]
28  E057  libzfs_import -> zpool_cmd  [res: fallback]
```
Ends: The pools are imported but nothing is mounted (`-N`); `zfs-mount.service` mounts them later with `zfs mount -a`, which also replays their logs. Without a cachefile, `zfs-import-scan.service` imports by scanning (path `discover`, then `import` with `-aN`) and keeps the pools out of any cachefile.

### 10.13 `export` - zpool export

Category: Export. Unmounts the pool's file systems, then the kernel checks that nothing holds the pool, lets the last txgs sync with every label marked EXPORTED, closes the devices and forgets the pool.

Alternatives:
- `mode`: `normal` zpool export; `f` -f: force the unmounts and ignore an active shared spare; `F` -F: hard force, no EXPORTED labels and no cachefile update; `busy` refused because the pool is still in use

```
 1  E104  admin -> zpool_cmd
 2  E083  zpool_cmd -> mount_lib
 3  E084  mount_lib -> vfs_umount
 4  E085  zpool_cmd -> libzfs_export
 5  E086  libzfs_export -> ioc_pool
 6  E087  ioc_pool -> spa_export
 7  E088  spa_export -> spa_ns
 8  E089  spa_export -> spa_async
 9  E090  spa_export -> txg_sync
10  E091  spa_export -> libzfs_export  [mode: busy]
11  E092  spa_export -> spa_unload  [mode: normal, f, F]
12  E093  spa_unload -> txg_sync  [mode: normal, f, F]
13  E072  txg_sync -> spa_sync  [mode: normal, f, F]
14  E073  spa_sync -> uberblock  [mode: normal, f, F]
15  E074  uberblock -> vdev_label  [mode: normal, f]  "every label rewritten with POOL_STATE_EXPORTED"
16  E074  uberblock -> vdev_label  [mode: F]  "nothing dirtied the labels: at most uberblocks are written and the labels still say ACTIVE"
17  E075  vdev_label -> dev_labels  [mode: normal, f, F]
18  E094  spa_unload -> mmp  [mode: normal, f, F]
19  E095  spa_unload -> vdev_leaf  [mode: normal, f, F]
20  E096  spa_export -> cachefile  [mode: normal, f]
21  E071  cachefile -> zpool_cache  [mode: normal, f]
22  E097  spa_export -> spa_ns  [mode: normal, f, F]
```
Ends: Normal and `-f`: the labels say EXPORTED, the pool is gone from the kernel and the cachefile, and any host can import it without `-f` (this host also skips the MMP check). `-F`: the pool is gone from the kernel, but labels and cachefile still describe an active pool, as after a crash. `busy`: the pool stays imported, already unmounted.

### 10.14 `checkpoint` - zpool import --rewind-to-checkpoint

Category: Recovery. A pool with a checkpoint (`zpool checkpoint`) can be imported at the checkpointed state. The checkpointed uberblock saved in the MOS is renumbered to outrank everything on disk, written to the labels, and the load starts over from it.

Alternatives:
- `mode`: `rw` rewind for good; `ro` with -o readonly=on: inspect the checkpointed state, write nothing

```
 1  E050  spa_import -> load_best
 2  E051  load_best -> spa_load
 3  E017  spa_load -> ub_select
 4  E018  dev_labels -> ub_select
 5  E022  ub_select -> ld_mos_open
 6  E025  spa_load -> ld_trusted
 7  E031  spa_load -> ckpt_rewind
 8  E032  ckpt_rewind -> uberblock  [mode: rw]
 9  E074  uberblock -> vdev_label  [mode: rw]
10  E075  vdev_label -> dev_labels  [mode: rw]
11  E033  ckpt_rewind -> spa_load
12  E017  spa_load -> ub_select  [mode: rw]  "the checkpointed uberblock is now the best one on disk"
13  E018  dev_labels -> ub_select  [mode: rw]
14  E017  spa_load -> ub_select  [mode: ro]  "read-only: the labels were not written, so the checkpointed uberblock in memory is used directly"
15  E022  ub_select -> ld_mos_open
16  E025  spa_load -> ld_trusted
17  E058  spa_load -> zil_replay  [mode: rw]  "log blocks from after the checkpoint may have been overwritten: unclaimed chains are cleared"
18  E060  spa_load -> txg_sync  [mode: rw]
```
Ends: `rw`: the pool is back at the checkpoint and everything written after it is gone for good. `ro`: the checkpointed state is imported read-only and the pool on disk is unchanged.

### 10.15 `async_work` - After import: resilver, config update, autoexpand

Category: After import. Work that the import only requests. Async work stays suspended for the whole load and is started by the end of a later spa_sync(), so the import returns before any of it runs.

```
 1  E062  spa_load -> resilver_start  "for example a disk that was absent while the pool was in use, so its DTL records the txgs it missed"
 2  E063  resilver_start -> spa_async
 3  E065  spa_load -> spa_async
 4  E052  spa_load -> load_best
 5  E054  load_best -> spa_import
 6  E066  spa_import -> spa_async
 7  E072  txg_sync -> spa_sync
 8  E067  spa_sync -> spa_async
 9  E069  spa_async -> cachefile
10  E070  cachefile -> txg_sync
11  E071  cachefile -> zpool_cache
12  E064  spa_async -> resilver_start
```
Ends: The labels and the cachefile describe the pool as this host imported it, and a resilver of the devices that missed writes is under way (`zfs-scrub-resilver:resilver`).

## 11. Accuracy rules and known simplifications

Rules: every function, line, tunable and property in this spec was checked at the pinned commit. OS-specific pieces use Linux names (`zpool_find_import_blkid`, `zpool_open_func`, `vdev_disk_open`, `zfs_domount`, the systemd units), with the FreeBSD equivalent named where it matters (`vdev_geom_open`).

Simplifications made on purpose. State these in the page's About overlay so nobody mistakes the diagram for the whole truth:

1. Every `zpool import` runs the search and tryimport of path `discover` before the real import; the import paths show that part as a single step.
2. `spa_load()` is one node with many outgoing wires; the order of its phases is given in its role text and the paths, not by the layout. Phases with no effect on import decisions (checkpoint txg, indirect vdevs, removals, deferred destroys, initialize and TRIM restart) appear only in role text.
3. Label and uberblock reads go from the device straight to the code that uses them; the zio pipeline and the leaf driver in between (I/O flow graph) are not drawn. Likewise the MOS and verification reads are single wires to the data disks.
4. The cachefile and the label rings are shown as devices; the cachefile is really a file on the root file system.
5. Errors are drawn where they decide the outcome. Most also produce an ereport (`spa_load()`), a zfs_dbgmsg note and an import progress entry (`/proc/spl/kstat/zfs/import_progress`), which are left out.
6. zvol devices (created after import, removed at export, with their own ZIL replay), `-l` key loading, `-t`, `-V`, `-D` and the events sent to zed are left out.
7. The fallback of a failed cachefile import and the `-a` taskqs are shown once each; the repeated per-pool work is not drawn again.

## 12. Build order

See `../zfs-io-flow-diagram-spec.md` section 12 and `zfs-viewer-suite-spec.md`.

## 13. Acceptance checklist

- Counts: 49 nodes, 104 wires, 15 paths, 320 path steps, 6 groups, 7 wire types, 141 functions in the index, 266 wire references (Appendix C), 16 tunable and property references (Appendix D).
- Activating path `import` with the default alternative (`mnt: mount`) highlights 51 distinct wires and plays 51 steps; `discover` highlights 29 distinct wires and plays 29 steps; `export` highlights 20 distinct wires and plays 20 steps.
- Node `spa_load` lists 8 incoming and 16 outgoing wires. Node `dev_labels` lists 4 incoming and 4 outgoing wires.
- The shared nodes (`spa_sync`, `txg_sync`, `uberblock`, `vdev_label`, `dev_labels`, `vdev_leaf`, `zil_replay`, `dev_normal`, `dev_slog`, `zpool_cmd`, `spa_ns`, `spa_export`, `spa_unload`, `cachefile`, `mount_lib`, `zpl_mount`, `vfs_umount`, `vdev_open`, `resilver_start`, `suspend`, `spa_async`) show "Also in" links and keep the other graphs' titles and contexts.
- Path `rewind` with `mode: plain` plays no wire into `txg_sync`; with `mode: F` it plays E058 and E060.
- Searching `zfs_multihost_interval` finds `mmp_check` and `mmp`; searching `cachefile` finds `cachefile` and `zpool_cache`.
- The `zfs-io-flow:crash_replay`, `zfs-io-flow:txg_sync`, `zfs-fault-management:suspend_clear` and `zfs-fault-management:device_removed` links open the named paths.
- The About overlay contains the seven mental-model points and the seven simplifications.

## Appendix A. Function index

Functions named in section 8, with file and line at commit `c913da8615`.

```
add_config  lib/libzutil/zutil_import.c:396
discover_cached_paths  lib/libzutil/zutil_import.c:1725
do_import  cmd/zpool/zpool_main.c:3823
do_import_task  cmd/zpool/zpool_main.c:3951
dsl_pool_init  module/zfs/dsl_pool.c:234
dsl_pool_open  module/zfs/dsl_pool.c:258
dsl_scan_restart_resilver  module/zfs/dsl_scan.c:1560
fix_paths  lib/libzutil/zutil_import.c:266
get_configs  lib/libzutil/zutil_import.c:575
get_system_hostid  lib/libspl/os/linux/gethostid.c:50
import_pools  cmd/zpool/zpool_main.c:3961
mmp_claim_uberblock  module/zfs/mmp.c:671
mmp_thread  module/zfs/mmp.c:729
mmp_thread_start  module/zfs/mmp.c:246
mmp_thread_stop  module/zfs/mmp.c:263
mmp_update_uberblock  module/zfs/mmp.c:436
mmp_write_uberblock  module/zfs/mmp.c:454
refresh_config  lib/libzfs/libzfs_import.c:60
show_import  cmd/zpool/zpool_main.c:3383
spa_activate  module/zfs/spa.c:1810
spa_activity_check_claim  module/zfs/spa.c:4335
spa_activity_check_duration  module/zfs/spa.c:4005
spa_activity_check_required  module/zfs/spa.c:3939
spa_activity_check_tryimport  module/zfs/spa.c:4228
spa_activity_verify_config  module/zfs/spa.c:3859
spa_add  module/zfs/spa_misc.c:814
spa_async_autoexpand  module/zfs/spa.c:10222
spa_async_dispatch  module/zfs/spa.c:10494
spa_async_request  module/zfs/spa.c:10506
spa_async_resume  module/zfs/spa.c:10444
spa_async_suspend  module/zfs/spa.c:10412
spa_async_thread  module/zfs/spa.c:10239
spa_check_for_missing_logs  module/zfs/spa.c:2827
spa_check_logs  module/zfs/spa.c:2898
spa_config_generate  module/zfs/spa_config.c:314
spa_config_parse  module/zfs/spa.c:2064
spa_config_update  module/zfs/spa_config.c:470
spa_config_write  module/zfs/spa_config.c:85
spa_configfile_set  module/zfs/spa.c:956
spa_deactivate  module/zfs/spa.c:1941
spa_export  module/zfs/spa.c:8185
spa_export_common  module/zfs/spa.c:7957
spa_features_check  module/zfs/zfeature.c:165
spa_import  module/zfs/spa.c:7637
spa_ld_activity_check  module/zfs/spa.c:4499
spa_ld_check_features  module/zfs/spa.c:5312
spa_ld_check_for_config_update  module/zfs/spa.c:5861
spa_ld_checkpoint_rewind  module/zfs/spa.c:6015
spa_ld_claim_log_blocks  module/zfs/spa.c:5836
spa_ld_get_props  module/zfs/spa.c:5454
spa_ld_load_special_directories  module/zfs/spa.c:5437
spa_ld_load_vdev_metadata  module/zfs/spa.c:5696
spa_ld_mos_init  module/zfs/spa.c:5940
spa_ld_mos_with_trusted_config  module/zfs/spa.c:6108
spa_ld_open_aux_vdevs  module/zfs/spa.c:5617
spa_ld_open_rootbp  module/zfs/spa.c:5057
spa_ld_open_vdevs  module/zfs/spa.c:4773
spa_ld_parse_config  module/zfs/spa.c:4655
spa_ld_prepare_for_reload  module/zfs/spa.c:5893
spa_ld_select_uberblock  module/zfs/spa.c:4890
spa_ld_select_uberblock_done  module/zfs/spa.c:4862
spa_ld_trusted_config  module/zfs/spa.c:5074
spa_ld_validate_vdevs  module/zfs/spa.c:4837
spa_ld_verify_logs  module/zfs/spa.c:5790
spa_ld_verify_pool_data  module/zfs/spa.c:5813
spa_load  module/zfs/spa.c:3773
spa_load_best  module/zfs/spa.c:6510
spa_load_impl  module/zfs/spa.c:6159
spa_load_retry  module/zfs/spa.c:6483
spa_load_verify  module/zfs/spa.c:3130
spa_load_verify_cb  module/zfs/spa.c:3058
spa_load_verify_done  module/zfs/spa.c:3011
spa_lookup  module/zfs/spa_misc.c:757
spa_remove  module/zfs/spa_misc.c:956
spa_sync  module/zfs/spa.c:11405
spa_sync_rewrite_vdev_config  module/zfs/spa.c:11355
spa_tryimport  module/zfs/spa.c:7819
spa_unload  module/zfs/spa.c:2317
spa_write_cachefile  module/zfs/spa_config.c:142
txg_sync_start  module/zfs/txg.c:188
txg_sync_stop  module/zfs/txg.c:251
txg_sync_thread  module/zfs/txg.c:510
txg_wait_synced  module/zfs/txg.c:764
uberblock_update  module/zfs/uberblock.c:39
unmount_one  lib/libzfs/libzfs_mount.c:579
vdev_config_sync  module/zfs/vdev_label.c:2243
vdev_copy_path_strict  module/zfs/vdev.c:2844
vdev_disk_close  module/os/linux/zfs/vdev_disk.c:542
vdev_disk_open  module/os/linux/zfs/vdev_disk.c:298
vdev_geom_open  module/os/freebsd/zfs/vdev_geom.c:796
vdev_label_read_config  module/zfs/vdev_label.c:863
vdev_label_sync_list  module/zfs/vdev_label.c:2163
vdev_label_write  module/zfs/vdev_label.c:205
vdev_load  module/zfs/vdev.c:3973
vdev_mirror_state_change  module/zfs/vdev_mirror.c:960
vdev_open  module/zfs/vdev.c:2216
vdev_open_children  module/zfs/vdev.c:2128
vdev_resilver_needed  module/zfs/vdev.c:3911
vdev_root_open  module/zfs/vdev_root.c:75
vdev_uberblock_compare  module/zfs/vdev_label.c:1604
vdev_uberblock_load  module/zfs/vdev_label.c:1710
vdev_uberblock_load_done  module/zfs/vdev_label.c:1645
vdev_uberblock_sync_list  module/zfs/vdev_label.c:1935
vdev_validate  module/zfs/vdev.c:2553
zfs_domount  module/os/linux/zfs/zfs_vfsops.c:1428
zfs_force_import_required  cmd/zpool/zpool_main.c:3783
zfs_ioc_pool_export  module/zfs/zfs_ioctl.c:1830
zfs_ioc_pool_import  module/zfs/zfs_ioctl.c:1793
zfs_ioc_pool_tryimport  module/zfs/zfs_ioctl.c:1900
zfs_mount_at  lib/libzfs/libzfs_mount.c:390
zfs_mount_one  lib/libzfs/libzfs_mount.c:1155
zfs_umount  module/os/linux/zfs/zfs_vfsops.c:1612
zfsvfs_setup  module/os/linux/zfs/zfs_vfsops.c:716
zfsvfs_teardown  module/os/linux/zfs/zfs_vfsops.c:1245
zil_claim  module/zfs/zil.c:1169
zil_claim_log_block  module/zfs/zil.c:617
zil_parse  module/zfs/zil.c:468
zil_replay  module/zfs/zil.c:5178
zio_suspend  module/zfs/zio.c:3016
zpl_get_tree  module/os/linux/zfs/zpl_super.c:839
zpool_default_search_paths  lib/libzutil/os/linux/zutil_import_os.c:276
zpool_disable_datasets  lib/libzfs/libzfs_mount.c:1388
zpool_do_export  cmd/zpool/zpool_main.c:2500
zpool_do_import  cmd/zpool/zpool_main.c:4360
zpool_enable_datasets  lib/libzfs/libzfs_mount.c:1314
zpool_explain_recover  lib/libzfs/libzfs_pool.c:2184
zpool_export  lib/libzfs/libzfs_pool.c:2095
zpool_export_common  lib/libzfs/libzfs_pool.c:2058
zpool_export_force  lib/libzfs/libzfs_pool.c:2105
zpool_export_one  cmd/zpool/zpool_main.c:2417
zpool_find_import  lib/libzutil/zutil_import.c:1946
zpool_find_import_blkid  lib/libzutil/os/linux/zutil_import_os.c:324
zpool_find_import_cached  lib/libzutil/zutil_import.c:1770
zpool_find_import_impl  lib/libzutil/zutil_import.c:1576
zpool_find_import_scan  lib/libzutil/zutil_import.c:1511
zpool_find_import_scan_dir  lib/libzutil/zutil_import.c:1410
zpool_import_props  lib/libzfs/libzfs_pool.c:2361
zpool_open_func  lib/libzutil/os/linux/zutil_import_os.c:141
zpool_read_label  lib/libzutil/zutil_import.c:1136
zpool_rewind_exclaim  lib/libzfs/libzfs_pool.c:2111
zpool_search_import  lib/libzutil/zutil_import.c:1987
```

## Appendix C. Wire source references

References for the 102 wires, at commit `c913da8615`. Each line is `<wire>  <file>:<line>  <symbol>`, and the symbol appears verbatim on that source line. A wire's references are listed in the order of the calls in its label.

```
E001  cmd/zpool/zpool_main.c:4629  zpool_search_import
E002  lib/libzutil/zutil_import.c:1996  zpool_find_import
E002  lib/libzutil/zutil_import.c:1974  zpool_find_import_blkid
E002  lib/libzutil/zutil_import.c:1968  zpool_find_import_scan
E003  lib/libzutil/zutil_import.c:1615  zpool_open_func
E004  lib/libzutil/os/linux/zutil_import_os.c:167  zpool_read_label
E004  lib/libzutil/zutil_import.c:1172  lio_listio
E004  lib/libzutil/os/linux/zutil_import_os.c:159  O_DIRECT
E005  lib/libzutil/zutil_import.c:1670  O_EXCL
E005  lib/libzutil/zutil_import.c:1674  add_config
E006  lib/libzutil/zutil_import.c:1694  get_configs
E006  lib/libzutil/zutil_import.c:905  fix_paths
E006  lib/libzutil/zutil_import.c:936  zutil_pool_active
E006  lib/libzutil/zutil_import.c:951  zutil_refresh_config
E007  lib/libzfs/libzfs_import.c:72  ZFS_IOC_POOL_TRYIMPORT
E008  module/zfs/zfs_ioctl.c:1909  spa_tryimport
E009  module/zfs/spa.c:7842  spa_add
E009  module/zfs/spa.c:7843  spa_activate
E009  module/zfs/spa.c:7941  spa_remove
E010  module/zfs/spa.c:7879  SPA_LOAD_TRYIMPORT
E010  module/zfs/spa.c:7877  spa_import_flags
E011  module/zfs/spa.c:5961  spa_ld_parse_config
E011  module/zfs/spa.c:4748  spa_config_parse
E011  module/zfs/spa.c:4700  EEXIST
E012  module/zfs/spa.c:5974  spa_ld_open_vdevs
E012  module/zfs/spa.c:4795  vdev_open
E013  module/zfs/vdev.c:2256  vdev_op_open
E013  module/os/linux/zfs/vdev_disk.c:1410  vdev_disk_open
E013  module/os/freebsd/zfs/vdev_geom.c:1282  vdev_geom_open
E014  module/zfs/vdev.c:2465  vdev_probe
E014  module/zfs/vdev.c:2008  zio_read_phys
E015  module/zfs/spa.c:5986  spa_ld_validate_vdevs
E015  module/zfs/spa.c:4843  vdev_validate
E016  module/zfs/vdev.c:2626  vdev_label_read_config
E016  module/zfs/vdev.c:2671  spa_trust_config
E017  module/zfs/spa.c:5998  spa_ld_select_uberblock
E018  module/zfs/spa.c:4922  vdev_uberblock_load
E018  module/zfs/vdev_label.c:1660  spa_load_max_txg
E018  module/zfs/vdev_label.c:1661  vdev_uberblock_compare
E018  module/zfs/vdev_label.c:1768  vdev_label_read_config
E019  module/zfs/spa.c:4951  spa_activity_check_required
E019  module/zfs/spa.c:4953  spa_ld_activity_check
E020  module/zfs/spa.c:4270  vdev_uberblock_load
E020  module/zfs/spa.c:4430  vdev_uberblock_load
E020  module/zfs/spa.c:4272  vdev_uberblock_compare
E021  module/zfs/spa.c:4506  spa_activity_set_load_info
E021  module/zfs/spa.c:4956  spa_ld_activity_result
E022  module/zfs/spa.c:6007  spa_ld_open_rootbp
E022  module/zfs/spa.c:5062  dsl_pool_init
E023  module/zfs/spa.c:4930  VDEV_AUX_CORRUPT_DATA
E023  module/zfs/spa.c:4974  VDEV_AUX_VERSION_NEWER
E023  module/zfs/spa.c:5030  ZPOOL_CONFIG_UNSUP_FEAT
E024  module/zfs/dsl_pool.c:247  dmu_objset_open_impl
E024  module/zfs/dmu_objset.c:500  arc_read
E025  module/zfs/spa.c:6126  spa_ld_trusted_config
E025  module/zfs/spa.c:5096  load_nvlist
E025  module/zfs/spa.c:5121  spa_config_parse
E025  module/zfs/spa.c:5139  vdev_copy_path_strict
E026  module/zfs/spa.c:5199  spa_trust_config
E026  module/zfs/spa.c:5204  spa_ld_open_vdevs
E026  module/zfs/spa.c:5208  spa_ld_validate_vdevs
E027  module/zfs/spa.c:5243  EAGAIN
E027  module/zfs/spa.c:6135  spa_ld_prepare_for_reload
E027  module/zfs/spa.c:6137  spa_ld_mos_init
E028  module/zfs/spa.c:5256  spa_activity_check_claim
E029  module/zfs/spa.c:4409  mmp_claim_uberblock
E029  module/zfs/mmp.c:661  vdev_label_write
E029  module/zfs/mmp.c:692  zio_flush
E029  module/zfs/mmp.c:720  ENODEV
E030  module/zfs/spa.c:5265  spa_check_for_missing_logs
E030  module/zfs/spa.c:2874  ENXIO
E030  module/zfs/spa.c:2882  SPA_LOG_CLEAR
E031  module/zfs/spa.c:6196  spa_ld_checkpoint_rewind
E031  module/zfs/spa.c:6024  DMU_POOL_ZPOOL_CHECKPOINT
E031  module/zfs/spa.c:6048  gethrestime_sec
E032  module/zfs/spa.c:6092  VDEV_CONFIG_REWINDING_CHECKPOINT
E033  module/zfs/spa.c:6204  spa_ld_prepare_for_reload
E033  module/zfs/spa.c:6206  spa_ld_mos_with_trusted_config
E034  module/zfs/spa.c:6243  spa_ld_check_features
E034  module/zfs/spa.c:5339  spa_features_check
E034  module/zfs/spa.c:5345  spa_features_check
E035  module/zfs/spa.c:5356  ZPOOL_CONFIG_UNSUP_FEAT
E035  module/zfs/spa.c:5364  ZPOOL_CONFIG_CAN_RDONLY
E035  module/zfs/spa.c:5390  ENOTSUP
E036  module/zfs/spa.c:6252  spa_ld_load_special_directories
E036  module/zfs/spa.c:5443  dsl_pool_open
E036  module/zfs/spa.c:6260  spa_ld_get_props
E036  module/zfs/spa.c:6269  spa_ld_open_aux_vdevs
E036  module/zfs/spa.c:6278  spa_ld_load_vdev_metadata
E036  module/zfs/spa.c:6283  spa_ld_load_dedup_tables
E036  module/zfs/spa.c:6288  spa_ld_load_brt
E037  module/zfs/spa.c:6297  spa_ld_verify_logs
E037  module/zfs/spa.c:5795  spa_check_logs
E037  module/zfs/spa.c:2910  zil_check_log_chain
E038  module/zfs/spa.c:6320  spa_ld_verify_pool_data
E038  module/zfs/spa.c:5823  spa_load_verify
E039  module/zfs/spa.c:3189  traverse_pool
E039  module/zfs/spa.c:3111  zio_read
E040  module/zfs/spa.c:3027  sle_relaxmeta
E040  module/zfs/spa.c:3219  zlp_maxmeta
E040  module/zfs/spa.c:3225  ZPOOL_CONFIG_LOAD_TXG
E041  module/zfs/spa.c:7885  spa_config_generate
E041  module/zfs/spa.c:7891  ZPOOL_CONFIG_LOAD_INFO
E041  module/zfs/spa.c:7939  spa_unload
E042  module/zfs/zfs_ioctl.c:1916  put_nvlist
E042  module/zfs/zfs_ioctl.c:1819  put_nvlist
E042  lib/libzfs/libzfs_import.c:81  zcmd_read_dst_nvlist
E042  lib/libzfs/libzfs_pool.c:2418  zcmd_read_dst_nvlist
E043  lib/libzutil/zutil_import.c:951  zutil_refresh_config
E043  cmd/zpool/zpool_main.c:4664  import_pools
E043  cmd/zpool/zpool_main.c:4036  show_import
E043  cmd/zpool/zpool_main.c:3415  zpool_import_status
E044  cmd/zpool/zpool_main.c:3835  SPA_VERSION_IS_SUPPORTED
E044  cmd/zpool/zpool_main.c:3839  zfs_force_import_required
E045  cmd/zpool/zpool_main.c:3840  ZFS_IMPORT_ANY_HOST
E045  cmd/zpool/zpool_main.c:3803  get_system_hostid
E045  cmd/zpool/zpool_main.c:3810  MMP_STATE_INACTIVE
E046  cmd/zpool/zpool_main.c:3908  zpool_import_props
E046  lib/libzfs/libzfs_pool.c:2382  zpool_name_valid
E046  lib/libzfs/libzfs_pool.c:2397  zpool_valid_proplist
E047  lib/libzfs/libzfs_pool.c:2412  ZFS_IOC_POOL_IMPORT
E047  lib/libzfs/libzfs_pool.c:2411  zc_cookie
E048  module/zfs/zfs_ioctl.c:1811  zc_guid
E048  module/zfs/zfs_ioctl.c:1814  spa_import
E049  module/zfs/spa.c:7654  spa_lookup
E049  module/zfs/spa.c:7668  spa_add
E050  module/zfs/spa.c:7667  SPA_MODE_READ
E050  module/zfs/spa.c:7686  spa_activate
E050  module/zfs/spa.c:7691  spa_async_suspend
E050  module/zfs/spa.c:7695  SPA_LOAD_RECOVER
E050  module/zfs/spa.c:7706  spa_load_best
E051  module/zfs/spa.c:6528  spa_load
E051  module/zfs/spa.c:6523  max_request
E052  module/zfs/spa.c:3784  spa_load_impl
E052  module/zfs/spa.c:6555  EREMOTEIO
E053  module/zfs/spa.c:6605  spa_load_retry
E053  module/zfs/spa.c:6490  spa_load_max_txg
E053  module/zfs/spa.c:6595  TXG_INITIAL
E054  module/zfs/spa.c:6622  ZPOOL_CONFIG_REWIND_INFO
E054  module/zfs/spa.c:7706  spa_load_best
E055  module/zfs/spa.c:7712  ZPOOL_CONFIG_LOAD_INFO
E055  module/zfs/spa.c:7738  spa_unload
E055  module/zfs/spa.c:7740  spa_remove
E056  lib/libzfs/libzfs_pool.c:2462  zpool_collect_unsup_feat
E056  lib/libzfs/libzfs_pool.c:2544  EZFS_ACTIVE_POOL
E056  lib/libzfs/libzfs_pool.c:2561  ZPOOL_CONFIG_MISSING_DEVICES
E056  lib/libzfs/libzfs_pool.c:2590  zpool_explain_recover
E057  lib/libzfs/libzfs_pool.c:2611  zpool_rewind_exclaim
E058  module/zfs/spa.c:6366  spa_ld_claim_log_blocks
E058  module/zfs/spa.c:5850  dmu_tx_create_assigned
E058  module/zfs/spa.c:5852  zil_claim
E058  module/zfs/zil.c:1269  zil_claim_log_block
E058  module/zfs/zil.c:632  zio_claim
E058  module/zfs/zil.c:1234  SPA_LOG_CLEAR
E059  module/zfs/zil.c:1269  zil_parse
E059  module/zfs/zil.c:519  zil_read_log_block
E060  module/zfs/spa.c:6371  spa_sync_on
E060  module/zfs/spa.c:6372  txg_sync_start
E060  module/zfs/spa.c:6383  spa_claim_max_txg
E061  module/zfs/spa.c:6373  mmp_thread_start
E062  module/zfs/spa.c:6400  vdev_rebuild_active
E062  module/zfs/spa.c:6401  vdev_rebuild_restart
E062  module/zfs/spa.c:6403  vdev_resilver_needed
E063  module/zfs/spa.c:6404  SPA_ASYNC_RESILVER
E064  module/zfs/spa.c:10342  dsl_scan_restart_resilver
E065  module/zfs/spa.c:6391  spa_ld_check_for_config_update
E065  module/zfs/spa.c:5889  SPA_ASYNC_CONFIG_UPDATE
E065  module/zfs/spa.c:6456  SPA_ASYNC_DEFER_DESTROY
E065  module/zfs/spa.c:6470  SPA_ASYNC_L2CACHE_REBUILD
E066  module/zfs/spa.c:7745  spa_async_resume
E066  module/zfs/spa.c:7803  SPA_ASYNC_AUTOEXPAND
E066  module/zfs/spa.c:10310  spa_async_autoexpand
E067  module/zfs/spa.c:11625  spa_async_dispatch
E067  module/zfs/spa.c:10499  spa_async_thread
E068  module/zfs/spa.c:7796  spa_config_update
E069  module/zfs/spa.c:10267  spa_config_update
E070  module/zfs/spa_config.c:481  vdev_config_dirty
E070  module/zfs/spa_config.c:514  txg_wait_synced
E070  module/zfs/spa_config.c:373  ZPOOL_CONFIG_HOSTID
E071  module/zfs/spa_config.c:520  spa_write_cachefile
E071  module/zfs/spa_config.c:207  spa_config_write
E071  module/zfs/spa_config.c:121  zfs_file_fsync
E072  module/zfs/txg.c:602  spa_sync
E073  module/zfs/spa.c:11529  spa_sync_rewrite_vdev_config
E073  module/zfs/spa.c:11381  vdev_config_sync
E073  module/zfs/spa.c:11378  spa_select_uberblock_vdevs
E074  module/zfs/vdev_label.c:2312  vdev_label_sync_list
E074  module/zfs/vdev_label.c:2345  vdev_uberblock_sync_list
E074  module/zfs/vdev_label.c:2367  vdev_label_sync_list
E075  module/zfs/vdev_label.c:2185  vdev_label_sync
E075  module/zfs/vdev_label.c:2150  vdev_label_write
E075  module/zfs/vdev_label.c:1944  vdev_uberblock_sync
E075  module/zfs/vdev_label.c:1925  vdev_label_write
E076  module/zfs/vdev_label.c:2355  mmp_update_uberblock
E077  module/zfs/mmp.c:871  mmp_write_uberblock
E077  module/zfs/mmp.c:473  mmp_next_leaf
E077  module/zfs/mmp.c:548  vdev_label_write
E078  module/zfs/mmp.c:867  ZIO_SUSPEND_MMP
E079  cmd/zpool/zpool_main.c:3926  ZFS_IMPORT_ONLY
E079  cmd/zpool/zpool_main.c:3927  zpool_enable_datasets
E079  lib/libzfs/libzfs_mount.c:1340  zfs_foreach_mountpoint
E079  lib/libzfs/libzfs_mount.c:1352  zfs_share_one
E080  lib/libzfs/libzfs_mount.c:1168  zfs_mount
E080  lib/libzfs/libzfs_mount.c:383  zfs_mount_at
E080  lib/libzfs/libzfs_mount.c:535  do_mount
E080  lib/libzfs/os/linux/libzfs_mount_os.c:335  mount(src
E080  module/os/linux/zfs/zpl_super.c:912  zfs_domount
E081  module/os/linux/zfs/zfs_vfsops.c:1517  zfsvfs_setup
E081  module/os/linux/zfs/zfs_vfsops.c:735  zil_open
E081  module/os/linux/zfs/zfs_vfsops.c:791  zil_replay
E081  module/os/linux/zfs/zfs_vfsops.c:788  zil_destroy
E082  module/zfs/zil.c:5221  zil_replay_log_record
E082  module/zfs/zil.c:5228  zil_destroy
E082  module/zfs/zil.c:5229  txg_wait_synced
E083  cmd/zpool/zpool_main.c:2428  zpool_disable_datasets
E083  lib/libzfs/libzfs_mount.c:1402  MNTTAB
E083  lib/libzfs/libzfs_mount.c:1467  unshare_one
E083  lib/libzfs/libzfs_mount.c:1479  unmount_one
E084  lib/libzfs/libzfs_mount.c:583  do_unmount
E084  lib/libzfs/os/linux/libzfs_mount_os.c:385  umount2
E084  module/os/linux/zfs/zfs_vfsops.c:1619  zfsvfs_teardown
E084  module/os/linux/zfs/zfs_vfsops.c:1296  zil_close
E084  module/os/linux/zfs/zfs_vfsops.c:1637  dmu_objset_disown
E085  cmd/zpool/zpool_main.c:2439  zpool_export
E085  cmd/zpool/zpool_main.c:2437  zpool_export_force
E085  cmd/zpool/zpool_main.c:2550  zpool_export_one_async
E086  lib/libzfs/libzfs_pool.c:2068  ZFS_IOC_POOL_EXPORT
E086  lib/libzfs/libzfs_pool.c:2064  zc_cookie
E086  lib/libzfs/libzfs_pool.c:2065  zc_guid
E087  module/zfs/zfs_ioctl.c:1837  spa_export
E087  module/zfs/spa.c:8188  spa_export_common
E088  module/zfs/spa.c:7971  spa_lookup
E088  module/zfs/spa.c:7979  ZFS_ERR_EXPORT_IN_PROGRESS
E089  module/zfs/spa.c:7992  spa_async_suspend
E090  module/zfs/spa.c:8024  txg_wait_synced
E090  module/zfs/spa.c:8025  spa_evicting_os_wait
E091  module/zfs/spa.c:8033  EBUSY
E091  module/zfs/spa.c:8060  EXDEV
E091  lib/libzfs/libzfs_pool.c:2076  EZFS_ACTIVE_SPARE
E092  module/zfs/spa.c:8046  zvol_remove_minors
E092  module/zfs/spa.c:8072  vdev_initialize_stop_all
E092  module/zfs/spa.c:8086  vdev_config_dirty
E092  module/zfs/spa.c:8108  spa_final_txg
E092  module/zfs/spa.c:8123  spa_unload
E093  module/zfs/spa.c:2373  txg_sync_stop
E093  module/zfs/txg.c:264  txg_wait_synced
E094  module/zfs/spa.c:2384  mmp_thread_stop
E095  module/zfs/spa.c:2413  vdev_free
E095  module/zfs/vdev.c:1202  vdev_close
E095  module/zfs/spa.c:2420  dsl_pool_close
E096  module/zfs/spa.c:8139  spa_write_cachefile
E097  module/zfs/spa.c:8140  spa_remove
E097  module/zfs/spa.c:8154  spa_namespace_broadcast
E098  etc/systemd/system/zfs-import-cache.service.in:20  zpool.cache
E098  etc/systemd/system/zfs-import-scan.service.in:19  cachefile=none
E099  lib/libzutil/zutil_import.c:1994  zpool_find_import_cached
E100  lib/libzutil/zutil_import.c:1814  nvlist_unpack
E100  lib/libzutil/zutil_import.c:1845  zutil_pool_active
E101  lib/libzutil/zutil_import.c:1916  ZPOOL_CONFIG_CACHEFILE
E101  lib/libzutil/zutil_import.c:1926  zutil_refresh_config
E101  module/zfs/spa.c:4784  zfs_max_missing_tvds_cachefile
E102  lib/libzutil/zutil_import.c:1889  discover_cached_paths
E102  lib/libzutil/zutil_import.c:1754  zpool_find_import_scan_dir
E102  lib/libzutil/zutil_import.c:1890  zpool_find_import_impl
E103  cmd/zpool/zpool_main.c:406  zpool_do_import
E104  cmd/zpool/zpool_main.c:407  zpool_do_export
```

## Appendix D. Tunable and property source references

Where each tunable and pool property named in section 8 is declared, at commit `c913da8615`. A tunable's symbol is the name as written in its `ZFS_MODULE_PARAM` line; a property's symbol is its quoted name in the `zprop_register_*()` call in `module/zcommon/zpool_prop.c`.

```
spa_config_path  module/zfs/spa_config.c:536  config_path
spa_load_verify_data  module/zfs/spa.c:12500  load_verify_data
spa_load_verify_metadata  module/zfs/spa.c:12497  load_verify_metadata
spa_load_verify_shift  module/zfs/spa.c:12493  load_verify_shift
zfs_max_missing_tvds  module/zfs/spa.c:12512  max_missing_tvds
zfs_max_missing_tvds_cachefile  module/zfs/spa.c:12516  max_missing_tvds_cachefile
zfs_max_missing_tvds_scan  module/zfs/spa.c:12519  max_missing_tvds_scan
zfs_multihost_fail_intervals  module/zfs/mmp.c:930  fail_intervals
zfs_multihost_import_intervals  module/zfs/mmp.c:933  import_intervals
zfs_multihost_interval  module/zfs/mmp.c:926  interval
altroot  module/zcommon/zpool_prop.c:98  "altroot"
autoexpand  module/zcommon/zpool_prop.c:202  "autoexpand"
cachefile  module/zcommon/zpool_prop.c:102  "cachefile"
failmode  module/zcommon/zpool_prop.c:213  "failmode"
multihost  module/zcommon/zpool_prop.c:208  "multihost"
readonly  module/zcommon/zpool_prop.c:205  "readonly"
```
