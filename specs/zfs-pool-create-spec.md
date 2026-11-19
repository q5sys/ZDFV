# ZFS pool creation (build spec)

This spec describes a diagram of `zpool create`: how the command line becomes a vdev specification, which checks can refuse the disks, how Linux whole disks are repartitioned, how the kernel turns the specification into a vdev tree (single disk, file, mirror, raidz, dRAID, special, dedup, log, plus the spare and cache lists that stay outside the tree), how sizes, ashift and metaslabs are decided, what labels are written at once, how the meta-object set (MOS), the root dataset and the feature objects are built for the first txg, and what is on disk once that txg has synced.

Source of truth: `https://github.com/openzfs/zfs` at commit `c913da86156eba3243cc1ef515e98d69887654a7` (master, 2026-11-13, version 2.4.99). Every function name, file path and tunable in this document was checked against that commit.

## 0. Instructions to the building agent

Render this spec with the viewer in `../viewer`, as extended by `zfs-viewer-suite-spec.md`. Treat sections 6 to 10 and the appendices as data. Do not add, remove or re-route nodes and wires unless you have verified the change in the source at the pinned commit.

## 1. Goal

One page that lets an administrator answer "what does `zpool create` actually do with my disks, how does each vdev type become part of the vdev tree, what gets written where, and what exists on disk after the first txg?" by following wires between boxes.

### Mental model the diagram has to convey

1. Most of the checking happens in userspace before the kernel is asked. `zpool` parses the vdev grammar into an nvlist tree, refuses devices that are in use and (unless `-f`) layouts with mismatched redundancy, and on Linux gives every whole disk a new GPT label: partition 1 for ZFS from 1 MiB, an 8 MiB reserved partition 9 at the end. Only then is one ioctl, ZFS_IOC_POOL_CREATE, issued.
2. The kernel builds a tree of vdev_t from that nvlist: a root vdev (its guid becomes the pool guid), top-level vdevs (a disk, a file, a mirror, a raidz or a dRAID), and leaves. Each top-level vdev belongs to one allocation class: normal, special, dedup or log. Hot spares and cache devices are not in the tree; they are separate auxiliary lists.
3. Sizes and ashift are settled at the first open. Each leaf reports its capacity and sector sizes; a mirror is as large as its smallest side, a raidz is its smallest child times its width (parity included), a dRAID leaves out its distributed spares and a reserve. The ashift chosen for each top-level vdev is kept for its life.
4. Every leaf carries four 256 KiB labels, two at the front and two at the end. Create writes provisional labels (pool txg 0) first, leaf by leaf, so a disk that belongs to an active pool, or the same disk named twice, fails with EBUSY before anything else is written.
5. The whole initial pool (MOS, pool directory, root, `$MOS`, `$FREE` and `$ORIGIN` directories, the root dataset with its file system objects, feature ZAPs, pool properties, history) is built in memory by the ioctl thread inside txg 4 (TXG_INITIAL), before the txg sync thread even exists.
6. The first txg sync writes it all: the pool config object, one space map per metaslab, the MOS and root dataset blocks, then the labels with the real config and the first uberblock. Only when that txg is on disk does `spa_create()` write `zpool.cache`, the root file system properties get set and `zpool` mount the new file system.
7. Each top-level vdev is cut into metaslabs when it is created: about 200 by default, each 512 MiB to 16 GiB; normal and special vdevs with more than 64 metaslabs give one of them to an embedded log class.
8. A failure in userspace leaves no pool, but whole disks may already have been repartitioned. A failure inside `spa_create()` unwinds everything in memory; a failure to set the root properties destroys the just-created pool again.

### Scope

In scope: `zpool create` option parsing, the vdev specification grammar, device in-use and replication checks, Linux whole-disk partitioning, features and the `compatibility` property, pool and root file system properties, the ioctl, `spa_create()`, vdev tree construction for disk, file, mirror, raidz, dRAID (with distributed spares), special, dedup and log vdevs, spares and cache devices, leaf open (ashift and size), initial labels, metaslab sizing and classes, `dsl_pool_create()`, the first txg sync, `zpool.cache`, and the main failure and rollback paths.

Out of scope: `zpool add` and `zpool attach` (they share much of this code), pool import and export (page `zfs-pool-import-export`), creating further datasets (page `zfs-dataset-create`), the encryption key handling of `-O encryption=on` (page `zfs-encryption-keys`), the AnyRAID vdev type (mentioned only in node text), FreeBSD partitioning, MMP (multihost), boot pools, and the zio pipeline and disk queues that carry the writes (I/O flow graph).

## 2. Deliverable

The page is built by `../viewer/build_graph.py --spec specs/zfs-pool-create-spec.md --repo zfs` and validated by `../viewer/validate_graph.py` with the same spec. Its page name is `zfs-pool-create.html`; it belongs to the suite described in `zfs-viewer-suite-spec.md`.

## 6. Wire types and contexts

### 6.1 Wire types

The colours are the suite-wide colours of `README.md` section 6. `cfg` is reserved for the pool create, dataset create, import/export and destroy graphs.

| type id | colour | name | what travels on the wire |
|---|---|---|---|
| `cfg` | `#FFD8A8` | Configuration and properties | nvlists: the vdev specification, leaf descriptions, the pool config, label contents, pool and file system property lists, feature lists. |
| `alloc` | `#C59F7B` | Space | Metaslab sizing, metaslab classes and groups, space map objects. |
| `tx` | `#FFD43B` | Transaction | The initial txg (TXG_INITIAL = 4): objects created under it, its commit and its sync. |
| `bp` | `#F783AC` | Block pointer | The MOS root block pointer handed to the uberblock. |
| `zio` | `#4DABF7` | I/O request | Label and block writes as zios. |
| `bio` | `#E9ECEF` | Device I/O | What reaches a device: opens, partition table writes, label and block writes. |
| `ctl` | `#868E96` | Control | Calls that carry no configuration: checks, opens, returns, errors, waits. Draw dashed. |

### 6.2 Execution contexts

| ctx id | meaning |
|---|---|
| `user` | Userspace (`zpool` command, libzfs, libefi, libblkid) |
| `syscall` | Kernel, in the thread of the calling process (an ioctl on /dev/zfs, mount(2) or umount(2)) or a helper thread it starts, outside syncing context and outside any dmu_tx |
| `sync` | Syncing context: txg_sync thread, one txg at a time |
| `thr` | A dedicated kernel thread (the txg sync thread) |
| `any` | Runs in whichever context calls it |
| `hw` | Hardware |

Most of `spa_create()` runs in `syscall` context although it creates objects under a dmu_tx: that transaction is made with `dmu_tx_create_assigned()` for TXG_INITIAL, flagged as syncing, and used before the txg sync thread is started. It is not the `open` context of the I/O graph.

## 7. Groups and default layout

Flow runs left to right: the `zpool` command on the left, the kernel's construction of the pool in the middle, the first txg and the devices on the right.

| group id | title | colour | first column | band | sub-columns | nodes | summary |
|---|---|---|---|---|---|---|---|
| `ucmd` | Userspace - zpool create, libzfs | `#5C5F66` | 0 | full | 2 | 10 | Grammar, checks, disk partitioning, features and the ioctl. Everything that can refuse the disks before the kernel sees them. |
| `kentry` | Kernel entry - ioctl | `#2B8A3E` | 2 | full | 1 | 2 | ZFS_IOC_POOL_CREATE and the root file system properties set afterwards. |
| `spa` | SPA - spa_create() | `#0C8599` | 3 | full | 1 | 6 | The orchestrator: namespace, activation, property checks, rollback and the cache file. |
| `vtree` | Vdev tree - parse, open, label | `#C2255C` | 4 | full | 2 | 10 | nvlist to vdev_t, per-type open and size, first labels, spares and cache devices. |
| `alloc` | Space - metaslabs and classes | `#846358` | 6 | full | 1 | 4 | Metaslab size and count, allocation classes, space maps. |
| `dsl` | MOS and root dataset (txg 4) | `#D9480F` | 7 | full | 2 | 6 | Everything created in memory for the first txg. |
| `txg` | First txg sync | `#E67700` | 9 | full | 2 | 6 | spa_sync() of txg 4: config object, MOS, labels, uberblock. |
| `io` | Shared - zio and leaf driver | `#1971C2` | 11 | full | 1 | 2 | The I/O graph's nodes that carry label and block writes to the devices. |
| `dev` | Physical devices | `#495057` | 12 | full | 1 | 8 | What ends up on each kind of device. |

Default layout rules:

- Column pitch is 400 px. A group starts at `first column * 400` and is `sub-columns` columns wide. A node's x is `(group first column + node sub-col) * 400`.
- Inside a sub-column, stack nodes top to bottom in the order they appear in the section 8 tables, 28 px apart. Node height follows its socket count.
- Band `full` groups start at the top.
- The layout must be deterministic. Do not run a force-directed or randomised layout in the page.
- Check the default at "fit all": group titles must be readable and no node may overlap another.

## 8. Nodes

54 nodes. `sub-col` is the node's column inside its group. `functions` are real symbols at the pinned commit (locations in Appendix A); the first one is the node's headline function. Sixteen nodes are shared with the I/O flow graph and keep its ids, titles and contexts. Others keep the ids, titles and contexts of other graphs: `vdev_open` (fault management), `zpool_cmd`, `libzfs`, `spa_unload` and `cachefile` (destroy; `libzfs` also snapshot lifecycle), `set_props` (dataset create).

### 8.1 Userspace - zpool create, libzfs (`ucmd`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `admin` | Administrator | 0 | `user` | - | - | The person or script typing the command. Every path in this graph that a command starts begins with a wire from this node; the arrows that come back into a command node are its results, errors and refusals. |
| `zpool_cmd` | zpool(8) command | 0 | `user` | `cmd/zpool/zpool_main.c` | `zpool_do_create`, `add_prop_list` | `zpool create` parses the options: `-f` force, `-n` dry run (print the layout, touch nothing), `-d` no features by default, `-o` pool properties and `feature@name=`, `-O` and `-m` root file system properties, `-R` altroot and `-t` temporary name (both default `cachefile=none`). A pool name containing `/` is refused. Hands the vdev arguments to make_root_vdev(), refuses a default mountpoint directory that exists and is not empty, builds the feature list, calls zpool_create() and on success opens, mounts and shares the root file system. Properties: `altroot`. |
| `vdev_spec` | make_root_vdev() / construct_spec() | 0 | `user` | `cmd/zpool/zpool_vdev.c` | `make_root_vdev`, `construct_spec`, `is_grouping`, `get_parity`, `draid_config_by_type`, `num_normal_vdevs` | The vdev grammar. `mirror`, `raidz[1-3]`, `draid[p][:Nd][:Nc][:Ns][:Nw]` (and `anymirror`) start a top-level vdev whose children are the following devices up to the next keyword; a bare device is a top-level vdev by itself. `special`, `dedup` and `log` mark the following top-level vdevs with an allocation bias (log accepts only disks and mirrors); `spare` and `cache` start lists that are not top-level vdevs. Each keyword checks its minimum device count. Without `:Nd`, a dRAID group gets at most 8 data disks. `-o ashift=` (9 to 16) is copied into every top-level vdev. At least one normal top-level vdev is required. Then, in order: in-use check, replication check unless `-f`, partitioning unless `-n`. Properties: `ashift`. |
| `leaf_spec` | make_leaf_vdev() | 0 | `user` | `cmd/zpool/zpool_vdev.c` | `make_leaf_vdev`, `is_shorthand_path`, `check_sector_size_database` | Turns one device argument into a leaf nvlist. A full path keeps the name given (so udev by-id names survive) but is resolved to decide whether it is a whole disk; a short name is looked up in the default device directories. A block device or whole disk becomes type `disk` with `whole_disk` set accordingly, a regular file type `file`; anything else is refused. Without `-o ashift`, drives known to misreport their sector size get an ashift from a built-in table. |
| `rep_check` | Replication-level check | 0 | `user` | `cmd/zpool/zpool_vdev.c` | `check_replication`, `get_replication`, `rep_consistent`, `is_bias_more_redundant`, `vdev_error` | Skipped with `-f`. All normal top-level vdevs must have the same type and redundancy (raidz and dRAID may mix at equal parity; raidz and mirror at equal failure tolerance); a mirror or raidz must not mix files and devices or devices whose sizes differ by more than 16 MiB. Special and dedup vdevs need not match as long as they survive at least as many device failures as the normal vdevs. Log vdevs are not checked. |
| `inuse_check` | Device in-use checks | 0 | `user` | `cmd/zpool/zpool_vdev.c` | `is_device_in_use`, `check_device`, `check_disk`, `check_slice`, `check_file_generic` | Runs for every leaf, spare and cache device, even with `-f`. A whole disk must open with O_EXCL; its GPT partitions are each probed with libblkid. A ZFS label is checked with zpool_in_use(): a member of an active pool, or a hot spare of another pool (unless this device is also a spare here), can never be used; an exported or possibly active pool, or any other filesystem signature, is refused unless `-f`. A corrupt primary GPT is refused unless `-f`. |
| `make_disks` | make_disks(): prepare disks | 1 | `user` | `cmd/zpool/zpool_vdev.c` | `make_disks`, `zero_label`, `zpool_prepare_and_label_disk` | Skipped with `-n`. A disk leaf that is a partition only has its first 4 KiB zeroed (unless it is a spare). A whole disk (not held open exclusively as an existing spare) is relabelled: the udev partition link is removed, the zfs_prepare_disk script runs, a GPT is written, `zpool` waits for udev to recreate the `-part1` link, zeroes its first 4 KiB, and from then on the leaf's path names partition 1. Files are left alone. |
| `efi_label` | zpool_label_disk(): GPT | 1 | `user` | `lib/libzfs/os/linux/libzfs_pool_os.c` | `zpool_label_disk`, `zpool_label_name`, `zpool_label_disk_check` | Writes a new GPT with libefi. Partition 1 (type V_USR, name `zfs-` plus 16 random hex digits) starts at 1 MiB and runs to the end of the disk less 8 MiB, rounded down to a 2048-sector boundary; partition 9 is an 8 MiB reserved partition after it. The same byte offsets are used on 512-byte and 4K-sector disks. A partition under 64 MiB fails. The label is read back and checked after udev settles. |
| `features_compat` | Feature set and compatibility | 1 | `user` | `cmd/zpool/zpool_main.c` | `zpool_do_load_compat`, `zpool_load_compat` | Reads the `compatibility` property: unset, empty or `off` means every feature, `legacy` none, otherwise the features present in all of the named files (from /etc/zfs/compatibility.d or /usr/share/zfs/compatibility.d). Unknown names in an /etc file are an error. `zpool_do_create()` then enables every feature the kernel module supports that the set allows, unless `-d` or `-o version` below 5000; `-o feature@x=disabled` removes one, and enabling one outside the set only warns. Properties: `compatibility`. |
| `libzfs` | libzfs / libzfs_core | 1 | `user` | `lib/libzfs/libzfs_pool.c` | `zpool_create`, `zpool_valid_proplist`, `zpool_create_error_from_info`, `zpool_standard_error_fmt`, `zfs_ioctl` | zpool_create() checks the pool name and property values (`feature@` values become the number 0), validates the `-O` properties as file system properties and, for `-O encryption`, prepares the wrapping key. Packs the vdev tree, the pool properties (with the root file system properties nested inside) into a zfs_cmd_t and issues ZFS_IOC_POOL_CREATE directly, not through libzfs_core. Turns errors into messages, using the device and pool names the kernel returns for EBUSY and ENXIO. |

### 8.2 Kernel entry - ioctl (`kentry`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `ioc_pool_create` | zfs_ioc_pool_create() | 0 | `syscall` | `module/zfs/zfs_ioctl.c` | `zfs_ioc_pool_create`, `zfs_fill_zplprops_root`, `spa_destroy` | Kernel entry for ZFS_IOC_POOL_CREATE. Unpacks the config and properties, rejects an unsupported `version`, separates the root file system properties, builds the encryption parameters and the ZPL creation properties (normalization, utf8only, casesensitivity, ZPL version) for the root dataset, and calls spa_create(). Afterwards sets the remaining root properties; if that fails, spa_destroy() removes the new pool again and the ioctl returns the error. |
| `set_props` | zfs_set_prop_nvlist() | 0 | `syscall` | `module/zfs/zfs_ioctl.c` | `zfs_set_prop_nvlist` | After the pool exists, the `-O` and `-m` properties are set on the root dataset with source local, as `zfs set` would. |

### 8.3 SPA - spa_create() (`spa`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `spa_create` | spa_create() | 0 | `syscall` | `module/zfs/spa.c` | `spa_create`, `spa_create_check_encryption_params` | Builds a pool from nothing while holding the namespace lock. In order: name check and spa_t, activation, property and encryption checks (special or dedup vdevs need `feature@allocation_classes`), vdev tree parse, create (open and label), dRAID spares and their feature gates, aux devices, metaslabs; then the DSL pool, dedup and BRT tables, the pool objects and properties for txg 4, feature refcounts for dRAID and AnyRAID; then it starts the txg threads, waits for txg 4 to sync, writes the cache file and returns. The version is SPA_VERSION (5000, feature flags) unless `-o version` was given without features. |
| `spa_ns` | SPA namespace | 0 | `syscall` | `module/zfs/spa_misc.c` | `spa_lookup`, `spa_add`, `spa_namespace_enter`, `spa_namespace_exit` | The system-wide table of pools. spa_create() holds its lock from the name check to the end, so no other pool operation runs meanwhile. spa_add() creates the in-memory spa_t with the altroot and a cache file entry for /etc/zfs/zpool.cache (none when an altroot is set). |
| `spa_activate` | spa_activate() | 0 | `syscall` | `module/zfs/spa.c` | `spa_activate`, `spa_create_zio_taskqs`, `metaslab_class_create` | Makes the spa_t usable: state ACTIVE, the six metaslab classes (normal, log, embedded_log, special, special_embedded_log, dedup), the zio taskqs and the per-txg lists. |
| `prop_validate` | spa_prop_validate() | 0 | `syscall` | `module/zfs/spa.c` | `spa_prop_validate` | Checks each pool property: `feature@` names must be known features with value 0, `version` must not be combined with features, booleans 0 or 1, `cachefile` an absolute path, empty or `none`, `multihost` needs a host id, `comment` must be printable. |
| `spa_unload` | spa_unload() | 0 | `syscall` | `module/zfs/spa.c` | `spa_unload`, `spa_deactivate`, `spa_remove` | Any error inside spa_create() unwinds what exists so far: spa_unload() closes and frees the vdev tree (once there is one), spa_deactivate() frees classes and taskqs, spa_remove() takes the name out of the namespace. Nothing reaches the cache file. Labels already written stay on disk, but with pool txg 0 they do not describe an importable pool. |
| `cachefile` | Pool cache file (zpool.cache) | 0 | `syscall` | `module/zfs/spa_config.c` | `spa_write_cachefile`, `spa_config_write` | After txg 4 has synced, writes the config of every pool that uses the same cache file into it (default /etc/zfs/zpool.cache), truncating and rewriting in place with O_SYNC. Nothing is written for `cachefile=none` or an altroot without a cache file. Posts a config sync sysevent and udev change events for the new devices. Failures are retried asynchronously. Tunables: `spa_config_path`. Properties: `cachefile`. |

### 8.4 Vdev tree - parse, open, label (`vtree`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `config_parse` | spa_config_parse() | 0 | `syscall` | `module/zfs/spa.c` | `spa_config_parse` | Recursive walk of the nvlist: one vdev_alloc() per nvlist, then its ZPOOL_CONFIG_CHILDREN. It follows only `children`: the `spares` and `l2cache` arrays beside them are not parsed into the tree. Holds every config lock (SCL_ALL) as writer. |
| `vdev_alloc` | vdev_alloc() | 0 | `syscall` | `module/zfs/vdev.c` | `vdev_alloc`, `vdev_getops`, `vdev_alloc_common`, `vdev_derive_alloc_bias`, `vdev_add_child` | Creates one vdev_t: picks the ops vector by type (root, mirror, raidz, draid, disk, file, anymirror ...), runs the type's init hook, assigns a random guid (the root vdev's guid becomes the pool guid; others are unique within the pool), records path, devid, whole_disk and the requested ashift, sets the allocation bias of a top-level vdev from its nvlist and `vdev_islog` for log vdevs, and links it to its parent. |
| `vdev_create` | vdev_create() | 0 | `syscall` | `module/zfs/vdev.c` | `vdev_create` | Opens the whole tree and labels it. Unlike an import, a create allows no partial open: every vdev must come up HEALTHY. |
| `vdev_open` | vdev_open() / vdev_reopen() | 0 | `any` | `module/zfs/vdev.c` | `vdev_open`, `vdev_ashift_optimize`, `vdev_open_children` | Calls the type's open, which for interior vdevs opens the children first. A leaf below 64 MiB fails with EOVERFLOW. Usable size (asize) is the device size less 4 MiB in front (two labels plus the 3.5 MiB boot area) and 512 KiB at the end. On the first open of a top-level vdev, ashift is the requested value or else the logical ashift, raised toward the physical ashift (up to zfs_vdev_max_auto_ashift, at least zfs_vdev_min_auto_ashift) by vdev_ashift_optimize(); it is fixed from then on. Each leaf is probed with label-area reads (vdev_probe()) before the open succeeds. Tunables: `zfs_vdev_min_auto_ashift`, `zfs_vdev_max_auto_ashift`. |
| `label_init` | vdev_label_init(): first labels | 0 | `syscall` | `module/zfs/vdev_label.c` | `vdev_label_init`, `vdev_inuse`, `vdev_aux_label_generate`, `spa_config_generate` | Walks the tree leaf by leaf, deliberately one at a time. Reads any existing label: one of an active pool, of a spare or cache device, or one written moments ago by this same create (the same disk listed twice) means EBUSY, with the device and the pool it belongs to recorded for the error message. Otherwise writes all four labels: the config of the pool and of this leaf's top-level vdev marked as pool txg 0 (not yet a real pool) with create_txg 4, a zeroed bootenv area, and an uberblock ring holding only a template with txg 0. Spares and cache devices get a short aux label instead. |
| `vdev_mirror` | Mirror vdev | 1 | `any` | `module/zfs/vdev_mirror.c` | `vdev_mirror_open` | Shared with the I/O flow graph. At create, opening a mirror opens each side; its size is that of the smallest side and its logical ashift the largest of the sides. All sides must open, as for every create. |
| `vdev_raidz` | RAIDZ / dRAID vdev | 1 | `any` | `module/zfs/vdev_raidz.c` | `vdev_raidz_init`, `vdev_raidz_open`, `vdev_draid_init`, `vdev_draid_open`, `vdev_draid_metaslab_init` | Shared with the I/O flow graph. raidz: init reads the parity (1 to 3); open needs at least parity + 1 children, and the size is the smallest child times the number of children, parity included. dRAID: init reads data disks, parity, distributed spares and groups and builds the permuted mapping of groups to children; open opens the data children, then the distributed spares, and sizes the vdev as the smallest child less a 32 MiB reserve, times the children that are not spares, rounded down to whole groups. Each dRAID metaslab is aligned to the group width. |
| `draid_spares` | dRAID distributed spares | 1 | `syscall` | `module/zfs/vdev_draid.c` | `vdev_draid_spare_create` | For every distributed spare of every dRAID top-level vdev, appends a leaf nvlist of type `dspare` named `draid<parity>-<vdev id>-<spare id>` to the pool's spare list. From here on they are ordinary hot spares in the aux list, backed by space reserved on every child of their dRAID. Counts dRAID vdevs (and those with failure groups) for the feature checks. |
| `aux_validate` | spa_validate_aux() | 1 | `syscall` | `module/zfs/spa.c` | `spa_validate_aux`, `spa_validate_aux_devs` | Checks the `spares` and then the `l2cache` arrays: each entry must parse as a single leaf, which is made its own top-level vdev, opened and given an aux label; its new guid is written back into the nvlist and the temporary vdev_t is freed. At create any failure aborts. |
| `aux_load` | Spare and cache lists (sav) | 1 | `syscall` | `module/zfs/spa.c` | `spa_load_spares`, `spa_load_l2cache`, `spa_spare_add`, `spa_l2cache_add`, `l2arc_add_vdev` | Builds the pool's auxiliary vdev lists from the nvlist: each spare and cache device becomes a standalone vdev_t (not part of the root vdev's tree), is opened, and is registered system-wide by guid so other pools see it as a spare or cache device. Cache devices join the L2ARC. The lists are marked to be written to the MOS in the first sync. |

### 8.5 Space - metaslabs and classes (`alloc`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `ms_size` | vdev_metaslab_set_size() | 0 | `syscall` | `module/zfs/vdev.c` | `vdev_metaslab_set_size` | Chooses the metaslab size of a top-level vdev from its asize: aim for zfs_vdev_default_ms_count (200) metaslabs of at least 2^zfs_vdev_default_ms_shift (512 MiB), at least zfs_vdev_min_ms_count (16) metaslabs, at most 2^zfs_vdev_max_ms_shift (16 GiB) each until zfs_vdev_ms_count_limit (131072) would be exceeded, never below 16 MiB. Roughly: under 8 GB about 16 metaslabs, 8 to 100 GB one per 512 MiB, 100 GB to 3 TB about 200, larger ones 16 GiB each. Tunables: `zfs_vdev_default_ms_count`, `zfs_vdev_min_ms_count`, `zfs_vdev_ms_count_limit`, `zfs_vdev_default_ms_shift`, `zfs_vdev_max_ms_shift`. |
| `ms_init` | vdev_expand() / vdev_metaslab_init() | 0 | `syscall` | `module/zfs/vdev.c` | `vdev_expand`, `vdev_metaslab_init`, `metaslab_init` | For each top-level vdev: sets the deflate ratio, creates its metaslab groups and asize >> ms_shift metaslab_t structures, each marked dirty for txg 4 (space maps do not exist yet), and marks the vdev's config dirty so its labels are rewritten in the first sync. On a normal or special vdev with more than zfs_embedded_slog_min_ms (64) metaslabs, the emptiest metaslab is moved to the embedded log group, reserved for ZIL blocks. Tunables: `zfs_embedded_slog_min_ms`. |
| `classes` | Metaslab classes and groups | 0 | `any` | `module/zfs/metaslab.c` | `metaslab_group_create`, `vdev_metaslab_group_create`, `spa_normal_class`, `spa_special_class`, `spa_dedup_class`, `spa_log_class`, `spa_embedded_log_class` | Where a top-level vdev's space is offered. Its metaslab group joins the class of its allocation bias: log, special, dedup, or normal for everything else. Normal and dedup vdevs also get a group in the embedded log class, special vdevs one in the special embedded log class; log vdevs have only their log group. The pool's minimum and maximum ashift are tracked over normal-class vdevs only. |
| `space_map` | Space maps (metaslab_sync) | 0 | `sync` | `module/zfs/metaslab.c` | `vdev_sync`, `metaslab_sync`, `space_map_alloc` | Shared with the I/O flow graph. In the first sync, vdev_sync() gives each new top-level vdev its metaslab array object in the MOS, and metaslab_sync() creates a space map object for each metaslab, stores its object number in that array and logs the allocations made in this txg. |

### 8.6 MOS and root dataset (txg 4) (`dsl`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `dsl_pool_create` | dsl_pool_create(): the MOS | 0 | `syscall` | `module/zfs/dsl_pool.c` | `dsl_pool_create`, `dsl_pool_open_impl`, `dmu_objset_create_impl`, `dmu_tx_create_assigned` | Creates the DSL pool and, under a transaction assigned to txg 4, the meta-object set: an empty objset of type META whose root block pointer the first uberblock will point at. Then the pool directory, scan state, the special directories, feature objects and the root dataset. |
| `special_dirs` | Root, $MOS, $FREE, $ORIGIN | 0 | `syscall` | `module/zfs/dsl_dir.c` | `dsl_dir_create_sync`, `dsl_pool_open_special_dir`, `dsl_pool_create_origin`, `bpobj_alloc` | Object 1 of the MOS becomes the pool directory ZAP. The root dsl_dir is created (it carries the pool's name in the namespace), then `$MOS` (accounts the MOS's own space), `$FREE` with the pool-wide free bpobj, and `$ORIGIN` with its `$ORIGIN@$ORIGIN` snapshot, the origin of every clone-less dataset. |
| `root_ds` | Root dataset and file system | 0 | `syscall` | `module/zfs/dsl_dataset.c` | `dsl_dataset_create_sync_dd`, `zfs_create_fs` | The dataset named like the pool: a dsl_dataset under the root dsl_dir, its objset (type ZFS), and the ZPL objects inside it: master node with the ZPL version and creation properties, system attribute tables, the unlinked set and the root directory znode. With `-O encryption` it also gets its crypto key (page `zfs-encryption-keys`). |
| `feat_obj` | Feature ZAPs and refcounts | 1 | `any` | `module/zfs/zfeature.c` | `spa_feature_create_zap_objects`, `spa_feature_enable`, `feature_enable_sync`, `spa_feature_incr`, `spa_activate_allocation_classes` | Three MOS ZAPs list features for read, for write and their descriptions. Enabling a feature records it with refcount 0 (enabled, not active) and enables the features it depends on. A feature becomes active when its refcount rises: dRAID and AnyRAID at create, allocation_classes when a special or dedup vdev's ZAP is built in the first sync, others (avz_v2, log_spacemap ...) when first used. Only active features restrict which software can import the pool. |
| `pool_dir` | Pool directory objects | 1 | `syscall` | `module/zfs/spa_history.c` | `spa_history_create_obj`, `spa_history_log_version`, `ddt_create`, `brt_create` | Entries spa_create() adds to the pool directory under txg 4: the pool history object (with a first "create" record of the software version), the config object that the first sync fills, the creation version, the deflate flag, and the deferred-free bpobj. Also sets up the in-memory dedup and block-cloning tables (their objects appear only when first used) and a random checksum salt. |
| `pool_props` | Pool properties | 1 | `syscall` | `module/zfs/spa.c` | `spa_sync_props`, `spa_configfile_set` | Sets in-memory defaults, records the cache file choice, then applies the `-o` properties under txg 4: `feature@` entries enable features, `altroot`, `cachefile` and `readonly` are not stored, `comment` and `compatibility` go into the config, and the rest (including `ashift` and `autoexpand`) are stored in the pool properties ZAP. The `ashift` property itself does not set any vdev's ashift: zpool already copied it into each top-level vdev. Properties: `ashift`, `autoexpand`, `cachefile`, `compatibility`. |

### 8.7 First txg sync (`txg`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `txg_sync` | TXG: syncing (txg_sync_thread) | 0 | `thr` | `module/zfs/txg.c` | `txg_sync_thread`, `txg_sync_start`, `txg_wait_synced` | Shared with the I/O flow graph. spa_create() starts the quiesce and sync threads only after it has built txg 4 in memory, then waits in txg_wait_synced() until txg 4 is on disk. |
| `spa_sync` | spa_sync() | 0 | `sync` | `module/zfs/spa.c` | `spa_sync`, `spa_sync_iterate_to_convergence` | Shared with the I/O flow graph. Syncs txg 4, the pool's first: config object, aux lists, every dirty dataset and the MOS, then vdev_sync() for the new top-level vdevs. Creating space maps dirties the MOS again, so the passes repeat until nothing is dirty; then the labels and uberblock are written. |
| `dsl_pool_sync` | dsl_pool_sync() | 0 | `sync` | `module/zfs/dsl_pool.c` | `dsl_pool_sync`, `dsl_pool_sync_mos` | Shared with the I/O flow graph. Writes the dirty datasets of txg 4 (the root dataset and `$ORIGIN`), then the MOS, and hands the MOS root block pointer to the uberblock. |
| `config_obj` | Config object, vdev ZAPs, aux lists | 1 | `sync` | `module/zfs/spa.c` | `spa_sync_config_object`, `spa_sync_aux_dev`, `vdev_construct_zaps`, `vdev_zap_allocation_data` | Because the vdevs are config-dirty, the first pass creates the all-vdev ZAP and a ZAP for every leaf, top-level vdev and the root, stores each top-level vdev's allocation bias in its ZAP, generates the full pool config for txg 4 and writes it into the config object (it also becomes the in-memory config used for the cache file). With spares or cache devices, their lists are written as separate packed nvlist objects. |
| `uberblock` | Uberblock + label update | 1 | `sync` | `module/zfs/vdev_label.c` | `spa_sync_rewrite_vdev_config`, `vdev_config_sync`, `uberblock_update` | Shared with the I/O flow graph. The commit point of the new pool. Every top-level vdev is on the config-dirty list, so all of them get new labels. uberblock_update() fills in txg 4, the guid sum of the tree, the time and the MOS root block pointer; until it lands on disk the provisional labels say pool txg 0 and nothing is importable. |
| `vdev_label` | Label / uberblock writer | 1 | `sync` | `module/zfs/vdev_label.c` | `vdev_label_sync_list`, `vdev_uberblock_sync_list`, `vdev_label_write` | Shared with the I/O flow graph. Order: flush caches, even labels L0 and L2 with the real config, flush, uberblock written into the ring of every label, flush, odd labels L1 and L3, flush. Spare and cache devices keep their aux labels. |

### 8.8 Shared - zio and leaf driver (`io`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `zio_create` | zio create + execute | 0 | `any` | `module/zfs/zio.c` | `zio_write_phys`, `zio_root`, `zio_wait`, `zio_flush` | Shared with the I/O flow graph. Label writes are physical zios at fixed offsets under a root zio that the caller waits for; MOS and dataset blocks are ordinary write zios. Both pass the pipeline and the per-disk queue drawn in the I/O graph. |
| `vdev_leaf` | Leaf vdev driver | 0 | `any` | `module/os/linux/zfs/vdev_disk.c` | `vdev_disk_open`, `vdev_file_open`, `vdev_disk_io_start` | Shared with the I/O flow graph. Opening a leaf: a disk is opened by its configured path as a block device with ZFS as exclusive holder (retrying briefly while udev recreates links), and reports capacity, logical and physical block size, write cache, TRIM support and whether it is rotational. A file vdev opens a regular file and reports 512-byte sectors unless the vdev_file tunables say otherwise. Writes are then submitted as block I/O. Tunables: `vdev_file_logical_ashift`, `vdev_file_physical_ashift`. |

### 8.9 Physical devices (`dev`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `dev_gpt` | GPT partition table | 0 | `hw` | - | - | The partition table at the start and end of a whole disk. After `zpool create` on Linux: partition 1 for ZFS, partition 9 reserved (8 MiB). Read by the in-use checks, written by zpool_label_disk(). |
| `dev_normal` | Data disks (normal class) | 0 | `hw` | - | - | Shared with the I/O flow graph. The leaves of the normal top-level vdevs (or regular files for file vdevs). After the first txg they hold the MOS, the root dataset and the space maps, and without a special vdev all of the pool's metadata. |
| `dev_special` | Special vdev | 0 | `hw` | - | - | Shared with the I/O flow graph. With a special vdev, the metadata of the first txg normally lands here. |
| `dev_dedup` | Dedup vdev | 0 | `hw` | - | - | Shared with the I/O flow graph. Holds only labels and space maps after create; dedup tables appear when dedup is first used. |
| `dev_slog` | SLOG (log class) | 0 | `hw` | - | - | Shared with the I/O flow graph. A log vdev gets labels and metaslabs but no data at create; the ZIL writes there later. |
| `dev_l2arc` | Cache device (L2ARC) | 0 | `hw` | - | - | Shared with the I/O flow graph. Carries only an aux label naming it a cache device (no pool guid, no vdev tree); the L2ARC feed fills it later. |
| `dev_spare` | Hot spare disk | 0 | `hw` | - | - | A disk in the pool's spare list. It carries only an aux label (state spare, its guid, no pool guid), may be shared by several pools, and is attached in place of a failed disk later (page `zfs-fault-management`). |
| `dev_labels` | Labels L0-L3 + uberblock ring | 0 | `hw` | - | - | Shared with the I/O flow graph. Four 256 KiB labels per leaf: L0 and L1 in the first 512 KiB, L2 and L3 in the last 512 KiB, each with the pool and top-level vdev config and a ring of uberblocks. After create: first the provisional set (pool txg 0), then the real config and the uberblock of txg 4. |

## 9. Wires

95 wires. A wire runs from the node that hands something over to the node that receives it. Returns from function calls are drawn only where a result or an error matters. `on paths` lists the section 10 paths that use the wire.

| wire | from | to | type | label | on paths |
|---|---|---|---|---|---|
| E001 | `zpool_cmd` | `vdev_spec` | `cfg` | zpool_do_create(): make_root_vdev() on the vdev arguments, with replication checks unless -f | create_disk, vdev_types, alloc_classes, aux_vdevs, fail_exists, fail_userspace |
| E002 | `vdev_spec` | `leaf_spec` | `cfg` | construct_spec(): is_grouping() recognises keywords; make_leaf_vdev() for each device | create_disk, vdev_types, alloc_classes, aux_vdevs, fail_userspace |
| E003 | `leaf_spec` | `vdev_spec` | `cfg` | leaf nvlist: type disk or file, path, whole_disk, and ashift when given or known for the drive | create_disk, vdev_types, alloc_classes, aux_vdevs, fail_userspace |
| E004 | `vdev_spec` | `inuse_check` | `ctl` | make_root_vdev(): is_device_in_use() on every leaf, spare and cache device, even with -f | create_disk, vdev_types, aux_vdevs, fail_userspace |
| E005 | `inuse_check` | `dev_gpt` | `ctl` | check_device() -> check_disk(): exclusive open, efi_alloc_and_read(), check_slice() of each partition | create_disk, vdev_types, fail_userspace |
| E006 | `vdev_spec` | `rep_check` | `ctl` | check_replication() of the new spec (not called with -f) | create_disk, vdev_types, alloc_classes, fail_userspace |
| E007 | `vdev_spec` | `make_disks` | `cfg` | make_disks() unless -n: every disk leaf, spare and cache device is prepared | create_disk, vdev_types, aux_vdevs, fail_exists, fail_userspace |
| E008 | `make_disks` | `efi_label` | `ctl` | whole disk: zpool_prepare_and_label_disk() runs the zfs_prepare_disk script, then zpool_label_disk() | create_disk, vdev_types, aux_vdevs, fail_exists |
| E009 | `efi_label` | `dev_gpt` | `bio` | efi_alloc_and_init(); partition 1 named by zpool_label_name() from 1 MiB, reserved partition 9 of 8 MiB; efi_write(); efi_rescan() | create_disk, vdev_types, aux_vdevs, fail_exists |
| E010 | `make_disks` | `dev_normal` | `bio` | zpool_label_disk_wait() for the partition link, then zero_label() clears its first 4 KiB | create_disk, vdev_types |
| E011 | `make_disks` | `vdev_spec` | `cfg` | the leaf's path now names partition 1; update_vdev_config_dev_strs() adds devid and physical path | create_disk, vdev_types, aux_vdevs |
| E012 | `vdev_spec` | `zpool_cmd` | `cfg` | nvroot: type root, children (the top-level vdevs), and the spares and l2cache arrays | create_disk, vdev_types, alloc_classes, aux_vdevs, fail_exists, fail_userspace |
| E013 | `zpool_cmd` | `features_compat` | `ctl` | zpool_do_load_compat(compatibility) -> zpool_load_compat() | create_disk, features_props |
| E014 | `features_compat` | `zpool_cmd` | `cfg` | feature@x=disabled is removed; every other supported feature in the set is added as feature@x=enabled, unless -d | create_disk, features_props |
| E015 | `zpool_cmd` | `libzfs` | `cfg` | zpool_create(g_zfs, poolname, nvroot, props, fsprops) | create_disk, vdev_types, alloc_classes, aux_vdevs, features_props, fail_exists, fail_userspace, fail_kernel |
| E016 | `libzfs` | `ioc_pool_create` | `cfg` | vdev tree packed by zcmd_write_conf_nvlist(); zpool_valid_proplist() and zfs_valid_proplist(); zfs_ioctl(ZFS_IOC_POOL_CREATE) | create_disk, vdev_types, alloc_classes, aux_vdevs, features_props, fail_exists, fail_kernel |
| E017 | `ioc_pool_create` | `spa_create` | `cfg` | root file system properties split off; zfs_fill_zplprops_root(); spa_create(name, config, props, zplprops, dcp) | create_disk, vdev_types, alloc_classes, aux_vdevs, features_props, fail_exists, fail_kernel |
| E018 | `spa_create` | `spa_ns` | `ctl` | spa_namespace_enter(); spa_lookup() of the name; spa_add() creates the spa_t | create_disk, features_props, fail_exists, fail_kernel |
| E019 | `spa_create` | `spa_activate` | `ctl` | spa_activate(spa_mode_global) | create_disk, fail_kernel |
| E020 | `spa_create` | `prop_validate` | `cfg` | spa_prop_validate(props) | create_disk, features_props, fail_kernel |
| E021 | `spa_create` | `config_parse` | `cfg` | spa_config_enter(SCL_ALL, writer); spa_config_parse(nvroot, VDEV_ALLOC_ADD) | create_disk, vdev_types, alloc_classes, aux_vdevs, fail_kernel |
| E022 | `config_parse` | `vdev_alloc` | `cfg` | vdev_alloc() for this nvlist, then spa_config_parse() of each child | create_disk, vdev_types, alloc_classes, fail_kernel |
| E023 | `vdev_alloc` | `vdev_raidz` | `cfg` | type init hook: vdev_raidz_init() reads nparity; vdev_draid_init() reads the dRAID layout and generates the permutations | vdev_types |
| E024 | `spa_create` | `vdev_create` | `ctl` | vdev_create(rvd, TXG_INITIAL, B_FALSE) | create_disk, vdev_types, alloc_classes, aux_vdevs, fail_kernel |
| E025 | `vdev_create` | `vdev_open` | `ctl` | vdev_open() of the root; anything not HEALTHY fails the create | create_disk, vdev_types, alloc_classes, fail_kernel |
| E026 | `vdev_open` | `vdev_leaf` | `ctl` | vdev_op_open() of a leaf: vdev_disk_open() or vdev_file_open() | create_disk, vdev_types, alloc_classes, aux_vdevs, fail_kernel |
| E027 | `vdev_leaf` | `dev_normal` | `bio` | vdev_blkdev_get_by_path() opens the device; physical and logical block size; bdev_capacity() | create_disk, vdev_types, fail_kernel |
| E028 | `vdev_leaf` | `vdev_open` | `cfg` | psize, max_psize, and logical and physical ashift (log2 of the sector sizes) | create_disk, vdev_types, alloc_classes, aux_vdevs, fail_kernel |
| E029 | `vdev_open` | `vdev_create` | `cfg` | asize = size less VDEV_LABEL_START_SIZE and VDEV_LABEL_END_SIZE; top-level ashift set, vdev_ashift_optimize() | create_disk, vdev_types, alloc_classes, fail_kernel |
| E030 | `vdev_create` | `label_init` | `cfg` | vdev_label_init(vd, txg, VDEV_LABEL_CREATE) | create_disk, vdev_types, alloc_classes, fail_kernel |
| E031 | `label_init` | `zio_create` | `zio` | spa_config_generate() with pool txg 0; vdev_label_write() of config, bootenv pad and uberblock template to L0-L3; zio_wait() | create_disk, vdev_types, alloc_classes, aux_vdevs |
| E032 | `zio_create` | `vdev_leaf` | `zio` | through the vdev stages and the disk queue to vdev_op_io_start() | create_disk, vdev_types, alloc_classes, aux_vdevs, first_txg |
| E033 | `vdev_leaf` | `dev_labels` | `bio` | label writes at fixed offsets from vdev_label_offset(): two labels at each end of the device | create_disk, vdev_types, alloc_classes, aux_vdevs, first_txg |
| E034 | `spa_create` | `ms_size` | `alloc` | vdev_metaslab_set_size() for each top-level vdev | create_disk, vdev_types, alloc_classes |
| E035 | `spa_create` | `ms_init` | `alloc` | vdev_expand(vd, TXG_INITIAL): metaslabs created; vdev_config_dirty() | create_disk, vdev_types, alloc_classes |
| E036 | `ms_init` | `classes` | `alloc` | vdev_metaslab_group_create(): metaslab_group_create() in the class of the allocation bias, plus an embedded log group for non-log vdevs | create_disk, vdev_types, alloc_classes |
| E037 | `ms_init` | `classes` | `alloc` | more than zfs_embedded_slog_min_ms metaslabs: the emptiest one is re-created in the embedded log group | create_disk, alloc_classes |
| E038 | `spa_create` | `dsl_pool_create` | `tx` | dsl_pool_create(spa, zplprops, dcp, TXG_INITIAL) | create_disk, features_props |
| E039 | `dsl_pool_create` | `special_dirs` | `tx` | pool directory (object DMU_POOL_DIRECTORY_OBJECT), root dsl_dir, MOS_DIR_NAME, FREE_DIR_NAME, dsl_pool_create_origin() | create_disk |
| E040 | `dsl_pool_create` | `feat_obj` | `tx` | spa_feature_create_zap_objects(): features for read, for write, descriptions | create_disk, features_props |
| E041 | `dsl_pool_create` | `root_ds` | `tx` | dsl_dataset_create_sync_dd(); dmu_objset_create_impl() of type ZFS; zfs_create_fs() | create_disk, features_props |
| E042 | `spa_create` | `pool_dir` | `tx` | dmu_tx_create_assigned(TXG_INITIAL): history object, config object, creation version, deferred-free bpobj | create_disk |
| E043 | `spa_create` | `pool_props` | `cfg` | property defaults (autoexpand ...); spa_configfile_set(); spa_sync_props(props, tx) | create_disk, features_props |
| E044 | `pool_props` | `feat_obj` | `cfg` | feature@name: spa_feature_enable() -> feature_enable_sync(), refcount 0 | create_disk, features_props |
| E045 | `spa_create` | `feat_obj` | `tx` | spa_feature_incr() per dRAID top-level vdev (and per AnyRAID vdev): active from txg 4 | vdev_types, features_props |
| E046 | `spa_create` | `txg_sync` | `tx` | dmu_tx_commit(); txg_sync_start(); txg_wait_synced(dp, TXG_INITIAL) | create_disk, alloc_classes, aux_vdevs, first_txg, features_props |
| E047 | `txg_sync` | `spa_create` | `ctl` | tx_synced_txg has reached 4: txg_wait_synced() returns | create_disk, first_txg, features_props |
| E048 | `spa_create` | `cachefile` | `cfg` | spa_write_cachefile(spa, B_FALSE, B_TRUE, B_TRUE) | create_disk, first_txg, features_props |
| E049 | `spa_create` | `ioc_pool_create` | `ctl` | spa_load_state back to SPA_LOAD_NONE; spa_namespace_exit(); return 0 | create_disk, features_props, fail_kernel |
| E050 | `ioc_pool_create` | `set_props` | `cfg` | zfs_set_prop_nvlist(pool, ZPROP_SRC_LOCAL, rootprops) | create_disk, features_props, fail_kernel |
| E051 | `ioc_pool_create` | `libzfs` | `ctl` | ioctl returns 0 or an errno, with ZPOOL_CONFIG_CREATE_INFO naming a busy device; zfs_ioctl() returns | create_disk, fail_exists, fail_kernel |
| E052 | `libzfs` | `zpool_cmd` | `ctl` | zpool_create() returns 0; zpool_do_create() calls zfs_mount() and zfs_share() for the root file system | create_disk |
| E053 | `vdev_open` | `vdev_mirror` | `ctl` | vdev_op_open() of a mirror: vdev_mirror_open() | vdev_types |
| E054 | `vdev_mirror` | `vdev_open` | `ctl` | vdev_open_children(); asize = the smallest side | vdev_types |
| E055 | `vdev_open` | `vdev_raidz` | `ctl` | vdev_op_open(): vdev_raidz_open() or vdev_draid_open() | vdev_types |
| E056 | `vdev_raidz` | `vdev_open` | `ctl` | vdev_open_children(); raidz asize = smallest child x vdev_children; dRAID opens data children, then spares, and subtracts VDEV_DRAID_REFLOW_RESERVE | vdev_types |
| E057 | `spa_create` | `draid_spares` | `cfg` | vdev_draid_spare_create() appends draid<p>-<vdev>-<n> spares (VDEV_TYPE_DRAID name); ENOTSUP unless has_draid | vdev_types |
| E058 | `spa_create` | `aux_validate` | `cfg` | spa_validate_aux(nvroot, TXG_INITIAL): spares, then l2cache | create_disk, aux_vdevs |
| E059 | `aux_validate` | `config_parse` | `cfg` | spa_config_parse() of one aux device; it must be a leaf | aux_vdevs |
| E060 | `aux_validate` | `vdev_open` | `ctl` | vdev_open() of the standalone leaf | aux_vdevs |
| E061 | `aux_validate` | `label_init` | `cfg` | vdev_label_init(VDEV_LABEL_SPARE or VDEV_LABEL_L2CACHE); guid written back into the nvlist (ZPOOL_CONFIG_GUID); vdev_free() | aux_vdevs |
| E062 | `vdev_leaf` | `dev_spare` | `bio` | vdev_blkdev_get_by_path(): open the spare | aux_vdevs |
| E063 | `vdev_leaf` | `dev_l2arc` | `bio` | vdev_blkdev_get_by_path(): open the cache device | aux_vdevs |
| E064 | `spa_create` | `aux_load` | `cfg` | spa_load_spares(); sav_sync set; spa_load_l2cache() | vdev_types, aux_vdevs |
| E065 | `aux_load` | `vdev_open` | `ctl` | each device parsed again (VDEV_ALLOC_SPARE or VDEV_ALLOC_L2CACHE) and vdev_open(); spa_spare_add() / spa_l2cache_add() | aux_vdevs |
| E066 | `aux_load` | `dev_l2arc` | `ctl` | l2arc_add_vdev(): the device joins the L2ARC; SPA_ASYNC_L2CACHE_TRIM requested | aux_vdevs |
| E067 | `vdev_leaf` | `dev_special` | `bio` | vdev_blkdev_get_by_path(): open the special vdev's disks | alloc_classes |
| E068 | `vdev_leaf` | `dev_dedup` | `bio` | vdev_blkdev_get_by_path(): open the dedup vdev's disks | alloc_classes |
| E069 | `vdev_leaf` | `dev_slog` | `bio` | vdev_blkdev_get_by_path(): open the log vdev's disks | alloc_classes |
| E070 | `txg_sync` | `spa_sync` | `tx` | txg_sync_thread(): spa_sync(spa, 4), the first txg | alloc_classes, aux_vdevs, first_txg, features_props |
| E071 | `spa_sync` | `config_obj` | `cfg` | spa_sync_config_object(): vdev_construct_zaps(), spa_config_generate(), spa_sync_nvlist() into the config object | alloc_classes, first_txg |
| E072 | `config_obj` | `feat_obj` | `tx` | vdev_zap_allocation_data(): bias stored in the top-level ZAP; special or dedup -> spa_activate_allocation_classes() -> spa_feature_incr() | alloc_classes |
| E073 | `spa_sync` | `config_obj` | `cfg` | spa_sync_aux_dev(): spare and l2cache lists into new MOS objects (dmu_object_alloc()) | aux_vdevs, first_txg |
| E074 | `spa_sync` | `dsl_pool_sync` | `tx` | dsl_pool_sync(dp, 4) | first_txg, features_props |
| E075 | `dsl_pool_sync` | `zio_create` | `zio` | dmu_objset_sync() of the root dataset, $ORIGIN and then the MOS: ordinary block writes | first_txg |
| E076 | `vdev_leaf` | `dev_normal` | `bio` | vdev_disk_io_start(): MOS and dataset blocks of txg 4 | first_txg |
| E077 | `vdev_leaf` | `dev_special` | `bio` | vdev_disk_io_start(): metadata blocks of txg 4 on the special vdev | first_txg |
| E078 | `spa_sync` | `space_map` | `alloc` | vdev_sync(): metaslab array object (vdev_ms_array); metaslab_sync() -> space_map_alloc() per metaslab | first_txg |
| E079 | `space_map` | `spa_sync` | `ctl` | the new objects dirty the MOS: another pass while dmu_objset_is_dirty() | first_txg |
| E080 | `dsl_pool_sync` | `uberblock` | `bp` | dsl_pool_sync_mos(): spa_set_rootblkptr() with the MOS root block pointer | first_txg |
| E081 | `spa_sync` | `uberblock` | `tx` | spa_sync_rewrite_vdev_config(): vdev_config_sync() over all top-level vdevs | first_txg |
| E082 | `uberblock` | `vdev_label` | `cfg` | uberblock_update(txg 4); vdev_label_sync_list() L0, L2; vdev_uberblock_sync_list(); vdev_label_sync_list() L1, L3 | first_txg |
| E083 | `vdev_label` | `zio_create` | `zio` | vdev_label_write() -> zio_write_phys(); zio_flush() of each vdev | first_txg |
| E084 | `uberblock` | `txg_sync` | `ctl` | spa_sync() returns; tx_synced_txg = 4; tx_sync_done_cv wakes waiters | first_txg |
| E085 | `spa_ns` | `spa_create` | `ctl` | the name is taken: return EEXIST before anything is allocated | fail_exists |
| E086 | `spa_create` | `ioc_pool_create` | `ctl` | error return; after a vdev error spa_create_info goes back as errinfo | fail_exists, fail_kernel |
| E087 | `libzfs` | `zpool_cmd` | `ctl` | error message: EBUSY (device in use or listed twice), EOVERFLOW (below 64 MiB), zpool_standard_error() (EEXIST: EZFS_EXISTS, "pool already exists" ...) | fail_exists, fail_kernel |
| E088 | `inuse_check` | `vdev_spec` | `ctl` | exclusive open fails ("is in use", type from blkid_get_tag_value()), a POOL_STATE_ACTIVE pool, or another signature without force: is_device_in_use() is true | fail_userspace |
| E089 | `rep_check` | `vdev_spec` | `ctl` | vdev_error(): "mismatched replication level" or "contains devices of different sizes", under "use '-f' to override" unless is_force | fail_userspace |
| E090 | `vdev_spec` | `zpool_cmd` | `ctl` | make_root_vdev() returns NULL (nvroot): zpool create exits 1 | fail_userspace |
| E091 | `spa_create` | `spa_unload` | `ctl` | error (zfs_special_devs() without allocation_classes, bad props, vdev errors): spa_unload(), spa_deactivate(), spa_remove() | fail_kernel |
| E092 | `vdev_open` | `vdev_create` | `ctl` | leaf below SPA_MINDEVSIZE (64 MiB): EOVERFLOW; vdev_create() calls vdev_close() | fail_kernel |
| E093 | `label_init` | `vdev_create` | `ctl` | vdev_inuse() is true (active pool, spare or cache, or vdtxg == crtxg: listed twice); spa_create_info set; EBUSY | fail_kernel |
| E094 | `set_props` | `ioc_pool_create` | `ctl` | a root property fails: spa_destroy() of the new pool, error returned | fail_kernel |
| E095 | `admin` | `zpool_cmd` | `ctl` | runs zpool create [-f] [-o property=value] [-O fs-property=value] pool vdev-spec ... | create_disk, vdev_types, alloc_classes, aux_vdevs, features_props, fail_exists, fail_userspace, fail_kernel |

## 10. Paths

9 named paths, 247 steps in total. Each step is one wire; the caption for a step is that wire's label. Every wire in section 9 is on at least one path. The category is the heading the path is listed under in the left panel. Path syntax and alternatives are as in section 10 of the I/O spec.

### 10.1 `create_disk` - Create a pool on one whole disk

Category: Create. `zpool create tank /dev/disk/by-id/ata-X` from the command line to the mounted file system. The first txg is drawn as one wait here; path `first_txg` opens it up.

```
 1  E095  admin -> zpool_cmd
 2  E001  zpool_cmd -> vdev_spec
 3  E002  vdev_spec -> leaf_spec  "one device, no keyword: it is top-level vdev 0 by itself"
 4  E003  leaf_spec -> vdev_spec
 5  E004  vdev_spec -> inuse_check
 6  E005  inuse_check -> dev_gpt
 7  E006  vdev_spec -> rep_check  "a single top-level vdev has nothing to be compared with"
 8  E007  vdev_spec -> make_disks
 9  E008  make_disks -> efi_label
10  E009  efi_label -> dev_gpt  "whatever partitions the disk had are gone from here on"
11  E010  make_disks -> dev_normal
12  E011  make_disks -> vdev_spec
13  E012  vdev_spec -> zpool_cmd
14  E013  zpool_cmd -> features_compat
15  E014  features_compat -> zpool_cmd
16  E015  zpool_cmd -> libzfs
17  E016  libzfs -> ioc_pool_create
18  E017  ioc_pool_create -> spa_create
19  E018  spa_create -> spa_ns
20  E019  spa_create -> spa_activate
21  E020  spa_create -> prop_validate
22  E021  spa_create -> config_parse
23  E022  config_parse -> vdev_alloc  "root vdev (its guid is the pool guid), then the disk"
24  E024  spa_create -> vdev_create
25  E025  vdev_create -> vdev_open
26  E026  vdev_open -> vdev_leaf
27  E027  vdev_leaf -> dev_normal
28  E028  vdev_leaf -> vdev_open
29  E029  vdev_open -> vdev_create  "a 4K-sector disk normally gets ashift 12"
30  E030  vdev_create -> label_init
31  E031  label_init -> zio_create
32  E032  zio_create -> vdev_leaf
33  E033  vdev_leaf -> dev_labels
34  E058  spa_create -> aux_validate  "no spares or cache devices: nothing to check"
35  E034  spa_create -> ms_size
36  E035  spa_create -> ms_init
37  E036  ms_init -> classes  "normal class"
38  E037  ms_init -> classes
39  E038  spa_create -> dsl_pool_create
40  E039  dsl_pool_create -> special_dirs
41  E040  dsl_pool_create -> feat_obj
42  E041  dsl_pool_create -> root_ds
43  E042  spa_create -> pool_dir
44  E043  spa_create -> pool_props
45  E044  pool_props -> feat_obj
46  E046  spa_create -> txg_sync  "txg 4 is written now (path first_txg)"
47  E047  txg_sync -> spa_create
48  E048  spa_create -> cachefile
49  E049  spa_create -> ioc_pool_create
50  E050  ioc_pool_create -> set_props  "only when -O or -m was given"
51  E051  ioc_pool_create -> libzfs
52  E052  libzfs -> zpool_cmd
```
Ends: The disk has a GPT with ZFS in partition 1, four labels describing a one-vdev pool at txg 4, about 200 metaslabs with space maps (fewer on a small disk), and a MOS holding the pool directory, the root, `$MOS`, `$FREE` and `$ORIGIN` directories, the root dataset and the feature objects. The pool is in zpool.cache and its file system is mounted at /tank. The writes themselves follow `zfs-io-flow:txg_sync`.

### 10.2 `vdev_types` - Choosing the top-level vdev type

Category: Vdev layout. What changes between a single disk, a file, a mirror, a raidz and a dRAID: the grammar, the in-use and replication checks, partitioning, the type's init and open, the size of the top-level vdev, dRAID's distributed spares and its feature.

Alternatives:
- `vdev`: `disk` Single disk (no extra steps); `file` File vdev; `mirror` Mirror; `raidz` RAIDZ1, RAIDZ2 or RAIDZ3; `draid` dRAID

```
 1  E095  admin -> zpool_cmd
 2  E001  zpool_cmd -> vdev_spec
 3  E002  vdev_spec -> leaf_spec  "after mirror, raidzN or draid... the following devices are the children, up to the next keyword"
 4  E003  leaf_spec -> vdev_spec
 5  E004  vdev_spec -> inuse_check  "a file is only checked for a ZFS label of another pool"
 6  E005  inuse_check -> dev_gpt  [vdev: disk, mirror, raidz, draid]
 7  E006  vdev_spec -> rep_check  "a mirror, raidz or dRAID must not mix files and devices, nor sizes more than 16 MiB apart"
 8  E007  vdev_spec -> make_disks  "files are left untouched"
 9  E008  make_disks -> efi_label  [vdev: disk, mirror, raidz, draid]
10  E009  efi_label -> dev_gpt  [vdev: disk, mirror, raidz, draid]
11  E010  make_disks -> dev_normal  [vdev: disk, mirror, raidz, draid]
12  E011  make_disks -> vdev_spec  [vdev: disk, mirror, raidz, draid]
13  E012  vdev_spec -> zpool_cmd  "raidz carries nparity; dRAID carries nparity, ndata, nspares, ngroups and children from draid_config_by_type()"
14  E015  zpool_cmd -> libzfs
15  E016  libzfs -> ioc_pool_create
16  E017  ioc_pool_create -> spa_create
17  E021  spa_create -> config_parse
18  E022  config_parse -> vdev_alloc  "mirror, raidz and dRAID are interior top-level vdevs with their leaves as children"
19  E023  vdev_alloc -> vdev_raidz  [vdev: raidz, draid]
20  E024  spa_create -> vdev_create
21  E025  vdev_create -> vdev_open
22  E053  vdev_open -> vdev_mirror  [vdev: mirror]
23  E054  vdev_mirror -> vdev_open  [vdev: mirror]
24  E055  vdev_open -> vdev_raidz  [vdev: raidz, draid]
25  E056  vdev_raidz -> vdev_open  [vdev: raidz, draid]
26  E026  vdev_open -> vdev_leaf  "each leaf"
27  E027  vdev_leaf -> dev_normal  "a file vdev opens a regular file instead"
28  E028  vdev_leaf -> vdev_open
29  E029  vdev_open -> vdev_create  "ashift is chosen once per top-level vdev, from the largest sector size of its children"
30  E030  vdev_create -> label_init
31  E031  label_init -> zio_create
32  E032  zio_create -> vdev_leaf
33  E033  vdev_leaf -> dev_labels  "every leaf gets its own labels; each describes the whole top-level vdev it belongs to"
34  E057  spa_create -> draid_spares  [vdev: draid]
35  E064  spa_create -> aux_load  [vdev: draid]  "the distributed spares become the pool's hot spares"
36  E034  spa_create -> ms_size
37  E035  spa_create -> ms_init  "dRAID metaslabs are aligned to the group width"
38  E036  ms_init -> classes
39  E045  spa_create -> feat_obj  [vdev: draid]
```
Ends: One top-level vdev of the chosen type in the normal class, sized as its type dictates, with labels on every leaf. A dRAID pool also has its distributed spares in the spare list and the draid feature active.

### 10.3 `alloc_classes` - Special, dedup and log vdevs

Category: Vdev layout. `zpool create tank mirror A B special mirror C D` (or `dedup ...`, `log ...`): the keyword gives the following top-level vdevs an allocation bias, which decides the metaslab class their space joins.

Alternatives:
- `class`: `special` Special vdev (metadata, optionally small blocks); `dedup` Dedup vdev (dedup tables); `log` Log vdev (separate intent log)

```
 1  E095  admin -> zpool_cmd
 2  E001  zpool_cmd -> vdev_spec
 3  E002  vdev_spec -> leaf_spec  "special, dedup and log set allocation_bias on each following top-level vdev"
 4  E003  leaf_spec -> vdev_spec
 5  E006  vdev_spec -> rep_check  [class: special, dedup]  "must survive at least as many device failures as the normal vdevs; log vdevs are not checked"
 6  E012  vdev_spec -> zpool_cmd
 7  E015  zpool_cmd -> libzfs
 8  E016  libzfs -> ioc_pool_create
 9  E017  ioc_pool_create -> spa_create  "special and dedup need feature@allocation_classes (path fail_kernel)"
10  E021  spa_create -> config_parse
11  E022  config_parse -> vdev_alloc  "vdev_derive_alloc_bias() sets the bias; a log vdev also gets vdev_islog"
12  E024  spa_create -> vdev_create
13  E025  vdev_create -> vdev_open
14  E026  vdev_open -> vdev_leaf
15  E067  vdev_leaf -> dev_special  [class: special]
16  E068  vdev_leaf -> dev_dedup  [class: dedup]
17  E069  vdev_leaf -> dev_slog  [class: log]
18  E028  vdev_leaf -> vdev_open
19  E029  vdev_open -> vdev_create  "the pool's ashift range is tracked over normal vdevs only"
20  E030  vdev_create -> label_init
21  E031  label_init -> zio_create
22  E032  zio_create -> vdev_leaf
23  E033  vdev_leaf -> dev_labels
24  E034  spa_create -> ms_size
25  E035  spa_create -> ms_init
26  E036  ms_init -> classes  "special: special class and special embedded log; dedup: dedup class and embedded log; log: log class only"
27  E037  ms_init -> classes  [class: special]
28  E046  spa_create -> txg_sync
29  E070  txg_sync -> spa_sync
30  E071  spa_sync -> config_obj
31  E072  config_obj -> feat_obj  [class: special, dedup]
```
Ends: The pool has top-level vdevs in two classes. Special and dedup vdevs have their bias recorded in their top-level ZAP and the allocation_classes feature active; a log vdev is recorded through is_log in the config. Which blocks go where is decided at write time (`zfs-io-flow:txg_sync`).

### 10.4 `aux_vdevs` - Hot spares and cache devices

Category: Vdev layout. `zpool create tank raidz A B C spare D cache E`. Spares and cache devices are labelled and remembered, but never become part of the vdev tree and get no metaslabs.

Alternatives:
- `aux`: `spare` Hot spare; `cache` Cache device (L2ARC)

```
 1  E095  admin -> zpool_cmd
 2  E001  zpool_cmd -> vdev_spec
 3  E002  vdev_spec -> leaf_spec  "spare and cache start lists, each allowed once, not top-level vdevs"
 4  E003  leaf_spec -> vdev_spec
 5  E004  vdev_spec -> inuse_check  "a spare may be a spare of another pool too"
 6  E007  vdev_spec -> make_disks  "spare and cache disks are partitioned like data disks"
 7  E008  make_disks -> efi_label
 8  E009  efi_label -> dev_gpt
 9  E011  make_disks -> vdev_spec
10  E012  vdev_spec -> zpool_cmd  "spares and l2cache arrays sit beside the children"
11  E015  zpool_cmd -> libzfs
12  E016  libzfs -> ioc_pool_create
13  E017  ioc_pool_create -> spa_create
14  E021  spa_create -> config_parse  "only children are parsed into the tree"
15  E024  spa_create -> vdev_create  "the main tree is opened and labelled as in create_disk"
16  E058  spa_create -> aux_validate
17  E059  aux_validate -> config_parse
18  E060  aux_validate -> vdev_open
19  E026  vdev_open -> vdev_leaf
20  E062  vdev_leaf -> dev_spare  [aux: spare]
21  E063  vdev_leaf -> dev_l2arc  [aux: cache]
22  E028  vdev_leaf -> vdev_open
23  E061  aux_validate -> label_init
24  E031  label_init -> zio_create  "aux label: state spare or l2cache, the device guid and path; no pool guid, no vdev tree"
25  E032  zio_create -> vdev_leaf
26  E033  vdev_leaf -> dev_labels
27  E064  spa_create -> aux_load
28  E065  aux_load -> vdev_open
29  E066  aux_load -> dev_l2arc  [aux: cache]
30  E046  spa_create -> txg_sync
31  E070  txg_sync -> spa_sync
32  E073  spa_sync -> config_obj
```
Ends: The spare or cache device carries an aux label and is listed in its own MOS object, not in the vdev tree. A spare waits to be attached (`zfs-fault-management:zed_fault`); a cache device is part of the L2ARC at once.

### 10.5 `first_txg` - The first txg: what is written where

Category: First txg. spa_create() has built txg 4 in memory; now the sync thread writes it. This is the moment the pool starts to exist on disk.

Alternatives:
- `meta`: `normal` No special vdev; `special` With a special vdev

```
 1  E046  spa_create -> txg_sync
 2  E070  txg_sync -> spa_sync
 3  E071  spa_sync -> config_obj
 4  E073  spa_sync -> config_obj  "only with spares or cache devices"
 5  E074  spa_sync -> dsl_pool_sync
 6  E075  dsl_pool_sync -> zio_create
 7  E032  zio_create -> vdev_leaf
 8  E076  vdev_leaf -> dev_normal  [meta: normal]
 9  E077  vdev_leaf -> dev_special  [meta: special]
10  E078  spa_sync -> space_map
11  E079  space_map -> spa_sync
12  E080  dsl_pool_sync -> uberblock
13  E081  spa_sync -> uberblock
14  E082  uberblock -> vdev_label
15  E083  vdev_label -> zio_create
16  E032  zio_create -> vdev_leaf
17  E033  vdev_leaf -> dev_labels
18  E084  uberblock -> txg_sync
19  E047  txg_sync -> spa_create
20  E048  spa_create -> cachefile
```
Ends: On disk: the MOS and the root dataset, the config object, one space map per metaslab, and on every leaf labels with the real config and an uberblock for txg 4 pointing at the MOS. The pool can be imported from here on. The same commit sequence runs for every later txg (`zfs-io-flow:txg_sync`).

### 10.6 `features_props` - Features, compatibility and properties

Category: Features and properties. Where `-d`, `-o feature@...`, `-o compatibility=...`, the other `-o` pool properties and the `-O` file system properties end up.

```
 1  E095  admin -> zpool_cmd
 2  E013  zpool_cmd -> features_compat
 3  E014  features_compat -> zpool_cmd
 4  E015  zpool_cmd -> libzfs  "props: -o pool properties and feature@ entries; fsprops: -O and -m"
 5  E016  libzfs -> ioc_pool_create
 6  E017  ioc_pool_create -> spa_create  "the -O properties travel nested in props and are split off here"
 7  E018  spa_create -> spa_ns  "altroot is taken from props"
 8  E020  spa_create -> prop_validate
 9  E038  spa_create -> dsl_pool_create
10  E040  dsl_pool_create -> feat_obj
11  E041  dsl_pool_create -> root_ds  "zplprops from zfs_fill_zplprops_root() shape the root file system"
12  E043  spa_create -> pool_props
13  E044  pool_props -> feat_obj
14  E045  spa_create -> feat_obj  "only with dRAID or AnyRAID vdevs"
15  E046  spa_create -> txg_sync
16  E070  txg_sync -> spa_sync
17  E074  spa_sync -> dsl_pool_sync  "the feature ZAPs and the pool properties ZAP are written with the MOS"
18  E047  txg_sync -> spa_create
19  E048  spa_create -> cachefile  "nothing is written for cachefile=none"
20  E049  spa_create -> ioc_pool_create
21  E050  ioc_pool_create -> set_props
```
Ends: Features are enabled (most not yet active), pool properties are in the pool properties ZAP or the config, and the root dataset has its creation-time ZPL properties plus the `-O` properties set as local. With `-O encryption=on` the root dataset becomes an encryption root (`zfs-encryption-keys:create`).

### 10.7 `fail_exists` - Failure: the pool name exists

Category: Failures. `zpool create tank ...` while a pool named tank is imported. The kernel refuses at once, but only after zpool has already repartitioned the disks.

```
 1  E095  admin -> zpool_cmd
 2  E001  zpool_cmd -> vdev_spec
 3  E007  vdev_spec -> make_disks  "the disks are prepared before the kernel is asked"
 4  E008  make_disks -> efi_label
 5  E009  efi_label -> dev_gpt
 6  E012  vdev_spec -> zpool_cmd
 7  E015  zpool_cmd -> libzfs
 8  E016  libzfs -> ioc_pool_create
 9  E017  ioc_pool_create -> spa_create
10  E018  spa_create -> spa_ns
11  E085  spa_ns -> spa_create
12  E086  spa_create -> ioc_pool_create
13  E051  ioc_pool_create -> libzfs
14  E087  libzfs -> zpool_cmd  "cannot create 'tank': pool already exists"
```
Ends: No kernel state changed, but whole disks named in the command now carry a fresh GPT; what they held before is no longer reachable through their old partition table.

### 10.8 `fail_userspace` - Failure caught by zpool

Category: Failures. The checks in make_root_vdev() refuse a device in use or a layout with mismatched redundancy before anything is written; `-f` skips the replication check entirely but not the in-use check.

Alternatives:
- `check`: `inuse` Device in use; `replication` Mismatched replication level; `forced` Mismatched replication with -f (create continues)

```
 1  E095  admin -> zpool_cmd
 2  E001  zpool_cmd -> vdev_spec
 3  E002  vdev_spec -> leaf_spec
 4  E003  leaf_spec -> vdev_spec
 5  E004  vdev_spec -> inuse_check
 6  E005  inuse_check -> dev_gpt
 7  E088  inuse_check -> vdev_spec  [check: inuse]
 8  E006  vdev_spec -> rep_check  [check: replication]  "for example a mirror beside a raidz2, or raidz1 beside raidz2"
 9  E089  rep_check -> vdev_spec  [check: replication]
10  E090  vdev_spec -> zpool_cmd  [check: inuse, replication]
11  E007  vdev_spec -> make_disks  [check: forced]  "with -f, check_replication() is never called"
12  E012  vdev_spec -> zpool_cmd  [check: forced]
13  E015  zpool_cmd -> libzfs  [check: forced]
```
Ends: inuse or replication: nothing was written and no ioctl was issued. forced: the create goes on as in `create_disk`, with a pool whose top-level vdevs differ in redundancy.

### 10.9 `fail_kernel` - Failure inside the kernel, and rollback

Category: Failures. Errors that only the kernel can see: a label that marks the device as in use (including the same disk named twice under different paths), a device too small, special or dedup vdevs without the allocation_classes feature, or a root file system property that cannot be set after the pool exists.

Alternatives:
- `error`: `busy` Device label in use (EBUSY); `small` Device below 64 MiB (EOVERFLOW); `feature` Special or dedup vdev without feature@allocation_classes (ENOTSUP); `rootprop` A -O property fails after the pool was created

```
 1  E095  admin -> zpool_cmd
 2  E015  zpool_cmd -> libzfs
 3  E016  libzfs -> ioc_pool_create
 4  E017  ioc_pool_create -> spa_create
 5  E018  spa_create -> spa_ns
 6  E019  spa_create -> spa_activate
 7  E020  spa_create -> prop_validate
 8  E021  spa_create -> config_parse  [error: busy, small]
 9  E022  config_parse -> vdev_alloc  [error: busy, small]
10  E024  spa_create -> vdev_create  [error: busy, small]
11  E025  vdev_create -> vdev_open  [error: busy, small]
12  E026  vdev_open -> vdev_leaf  [error: busy, small]
13  E027  vdev_leaf -> dev_normal  [error: busy, small]
14  E028  vdev_leaf -> vdev_open  [error: busy, small]
15  E092  vdev_open -> vdev_create  [error: small]
16  E029  vdev_open -> vdev_create  [error: busy]
17  E030  vdev_create -> label_init  [error: busy]
18  E093  label_init -> vdev_create  [error: busy]
19  E091  spa_create -> spa_unload  [error: busy, small, feature]
20  E086  spa_create -> ioc_pool_create  [error: busy, small, feature]
21  E049  spa_create -> ioc_pool_create  [error: rootprop]
22  E050  ioc_pool_create -> set_props  [error: rootprop]
23  E094  set_props -> ioc_pool_create  [error: rootprop]
24  E051  ioc_pool_create -> libzfs
25  E087  libzfs -> zpool_cmd
```
Ends: busy, small, feature: the spa_t, vdev tree and classes are freed and the name is free again; labels written before the failure say pool txg 0 and do not form an importable pool. rootprop: the pool had been fully created and is destroyed again.

## 11. Accuracy rules and known simplifications

Rules: every function, line, tunable and property in this spec was checked at the pinned commit. OS-specific pieces use Linux names (`vdev_disk_open`, `zpool_label_disk`, libblkid); FreeBSD uses GEOM and does not partition whole disks this way.

Simplifications made on purpose. State these in the page's About overlay so nobody mistakes the diagram for the whole truth:

1. Label and block writes jump from `zio_create` to the leaf driver; the pipeline stages and the per-disk queue between them are drawn in the I/O graph.
2. The vdev tree is recursive: vdev_open() and vdev_label_init() run once per vdev, and spa_config_parse() once per nvlist. Each is drawn once.
3. Return wires are drawn only where a size, an ashift or an error matters; most returns to `spa_create` are implied by the next step.
4. Leaf opens for the normal class, special, dedup, log, spare and cache devices are separate wires into separate device nodes; they are the same call (`vdev_disk_open()`).
5. dRAID is folded into the RAIDZ node, as in the I/O graph; AnyRAID (`anymirror`) appears only in node text.
6. The first txg is shown as one sync with its main writes; the second and later passes of spa_sync(), deferred frees, the log space map and MMP are left out.
7. `zpool create -n` (dry run), `-t` (temporary name), boot environments and encryption key handling are described in node text only.

## 12. Build order

See `../zfs-io-flow-diagram-spec.md` section 12 and `zfs-viewer-suite-spec.md`.

## 13. Acceptance checklist

- Counts: 54 nodes, 95 wires, 9 paths, 247 path steps, 9 groups, 7 wire types, 140 functions in the index, 191 wire references (Appendix C), 16 tunable and property references (Appendix D).
- Activating path `create_disk` with the default alternative highlights 52 distinct wires and plays 52 steps; `first_txg` highlights 18 and plays 19; `vdev_types` highlights 31 and plays 31.
- Node `spa_create` lists 3 incoming and 19 outgoing wires. Node `vdev_leaf` lists 2 incoming and 10 outgoing wires.
- The sixteen I/O nodes (`txg_sync`, `spa_sync`, `dsl_pool_sync`, `uberblock`, `vdev_label`, `space_map`, `zio_create`, `vdev_leaf`, `vdev_mirror`, `vdev_raidz` and the six `dev_` nodes other than `dev_gpt` and `dev_spare`) show "Also in: ZFS I/O Flow" and keep the I/O graph's titles and contexts; `vdev_open`, `zpool_cmd`, `libzfs`, `spa_unload`, `cachefile` and `set_props` show "Also in" links to the fault management, destroy, snapshot lifecycle and dataset create pages.
- Switching `vdev_types` to `vdev: mirror` adds the `vdev_mirror` wires; `vdev: draid` adds the raidz node wires, the distributed spares and the feature refcount.
- Searching `zfs_vdev_default_ms_count` finds `ms_size`; searching `ashift` finds `vdev_spec`, `vdev_open` and `pool_props`.
- The About overlay contains the eight mental-model points and the seven simplifications.

## Appendix A. Function index

140 functions named in section 8, with file and line at commit `c913da8615`.

```
add_prop_list  cmd/zpool/zpool_main.c:1274
bpobj_alloc  module/zfs/bpobj.c:69
brt_create  module/zfs/brt.c:1638
check_device  cmd/zpool/os/linux/zpool_vdev_os.c:380
check_disk  cmd/zpool/os/linux/zpool_vdev_os.c:301
check_file_generic  cmd/zpool/zpool_vdev.c:106
check_replication  cmd/zpool/zpool_vdev.c:844
check_sector_size_database  cmd/zpool/os/linux/zpool_vdev_os.c:208
check_slice  cmd/zpool/os/linux/zpool_vdev_os.c:256
construct_spec  cmd/zpool/zpool_vdev.c:1650
ddt_create  module/zfs/ddt.c:1801
dmu_objset_create_impl  module/zfs/dmu_objset.c:1159
dmu_tx_create_assigned  module/zfs/dmu_tx.c:81
draid_config_by_type  cmd/zpool/zpool_vdev.c:1445
dsl_dataset_create_sync_dd  module/zfs/dsl_dataset.c:1188
dsl_dir_create_sync  module/zfs/dsl_dir.c:943
dsl_pool_create  module/zfs/dsl_pool.c:475
dsl_pool_create_origin  module/zfs/dsl_pool.c:1263
dsl_pool_open_impl  module/zfs/dsl_pool.c:180
dsl_pool_open_special_dir  module/zfs/dsl_pool.c:165
dsl_pool_sync  module/zfs/dsl_pool.c:700
dsl_pool_sync_mos  module/zfs/dsl_pool.c:579
feature_enable_sync  module/zfs/zfeature.c:330
get_parity  cmd/zpool/zpool_vdev.c:1260
get_replication  cmd/zpool/zpool_vdev.c:582
is_bias_more_redundant  cmd/zpool/zpool_vdev.c:469
is_device_in_use  cmd/zpool/zpool_vdev.c:1186
is_grouping  cmd/zpool/zpool_vdev.c:1332
is_shorthand_path  cmd/zpool/zpool_vdev.c:176
l2arc_add_vdev  module/zfs/arc.c:10471
make_disks  cmd/zpool/zpool_vdev.c:1009
make_leaf_vdev  cmd/zpool/zpool_vdev.c:263
make_root_vdev  cmd/zpool/zpool_vdev.c:2171
metaslab_class_create  module/zfs/metaslab.c:431
metaslab_group_create  module/zfs/metaslab.c:1089
metaslab_init  module/zfs/metaslab.c:2932
metaslab_sync  module/zfs/metaslab.c:4347
num_normal_vdevs  cmd/zpool/zpool_vdev.c:2137
rep_consistent  cmd/zpool/zpool_vdev.c:490
spa_activate  module/zfs/spa.c:1810
spa_activate_allocation_classes  module/zfs/spa_misc.c:1847
spa_add  module/zfs/spa_misc.c:814
spa_config_generate  module/zfs/spa_config.c:314
spa_config_parse  module/zfs/spa.c:2064
spa_config_write  module/zfs/spa_config.c:85
spa_configfile_set  module/zfs/spa.c:956
spa_create  module/zfs/spa.c:7290
spa_create_check_encryption_params  module/zfs/spa.c:7275
spa_create_zio_taskqs  module/zfs/spa.c:1722
spa_deactivate  module/zfs/spa.c:1941
spa_dedup_class  module/zfs/spa_misc.c:2213
spa_destroy  module/zfs/spa.c:8175
spa_embedded_log_class  module/zfs/spa_misc.c:2195
spa_feature_create_zap_objects  module/zfs/zfeature.c:434
spa_feature_enable  module/zfs/zfeature.c:458
spa_feature_incr  module/zfs/zfeature.c:466
spa_history_create_obj  module/zfs/spa_history.c:75
spa_history_log_version  module/zfs/spa_history.c:607
spa_l2cache_add  module/zfs/spa_misc.c:1300
spa_load_l2cache  module/zfs/spa.c:2618
spa_load_spares  module/zfs/spa.c:2488
spa_log_class  module/zfs/spa_misc.c:2189
spa_lookup  module/zfs/spa_misc.c:757
spa_namespace_enter  module/zfs/spa_misc.c:656
spa_namespace_exit  module/zfs/spa_misc.c:680
spa_normal_class  module/zfs/spa_misc.c:2183
spa_prop_validate  module/zfs/spa.c:731
spa_remove  module/zfs/spa_misc.c:956
spa_spare_add  module/zfs/spa_misc.c:1247
spa_special_class  module/zfs/spa_misc.c:2201
spa_sync  module/zfs/spa.c:11405
spa_sync_aux_dev  module/zfs/spa.c:10640
spa_sync_config_object  module/zfs/spa.c:10714
spa_sync_iterate_to_convergence  module/zfs/spa.c:11192
spa_sync_props  module/zfs/spa.c:10851
spa_sync_rewrite_vdev_config  module/zfs/spa.c:11355
spa_unload  module/zfs/spa.c:2317
spa_validate_aux  module/zfs/spa.c:7189
spa_validate_aux_devs  module/zfs/spa.c:7120
spa_write_cachefile  module/zfs/spa_config.c:142
space_map_alloc  module/zfs/space_map.c:903
txg_sync_start  module/zfs/txg.c:188
txg_sync_thread  module/zfs/txg.c:510
txg_wait_synced  module/zfs/txg.c:764
uberblock_update  module/zfs/uberblock.c:39
vdev_add_child  module/zfs/vdev.c:589
vdev_alloc  module/zfs/vdev.c:839
vdev_alloc_common  module/zfs/vdev.c:715
vdev_ashift_optimize  module/zfs/vdev.c:2186
vdev_aux_label_generate  module/zfs/vdev_label.c:1105
vdev_config_sync  module/zfs/vdev_label.c:2243
vdev_construct_zaps  module/zfs/vdev.c:3763
vdev_create  module/zfs/vdev.c:3056
vdev_derive_alloc_bias  module/zfs/vdev.c:327
vdev_disk_io_start  module/os/linux/zfs/vdev_disk.c:1241
vdev_disk_open  module/os/linux/zfs/vdev_disk.c:298
vdev_draid_init  module/zfs/vdev_draid.c:2427
vdev_draid_metaslab_init  module/zfs/vdev_draid.c:1841
vdev_draid_open  module/zfs/vdev_draid.c:1694
vdev_draid_spare_create  module/zfs/vdev_draid.c:1864
vdev_error  cmd/zpool/zpool_vdev.c:81
vdev_expand  module/zfs/vdev.c:6040
vdev_file_open  module/zfs/vdev_file.c:90
vdev_getops  module/zfs/vdev.c:282
vdev_inuse  module/zfs/vdev_label.c:976
vdev_label_init  module/zfs/vdev_label.c:1154
vdev_label_sync_list  module/zfs/vdev_label.c:2163
vdev_label_write  module/zfs/vdev_label.c:205
vdev_metaslab_group_create  module/zfs/vdev.c:1584
vdev_metaslab_init  module/zfs/vdev.c:1663
vdev_metaslab_set_size  module/zfs/vdev.c:3086
vdev_mirror_open  module/zfs/vdev_mirror.c:361
vdev_open  module/zfs/vdev.c:2216
vdev_open_children  module/zfs/vdev.c:2128
vdev_raidz_init  module/zfs/vdev_raidz.c:5618
vdev_raidz_open  module/zfs/vdev_raidz.c:2218
vdev_sync  module/zfs/vdev.c:4409
vdev_uberblock_sync_list  module/zfs/vdev_label.c:1935
vdev_zap_allocation_data  module/zfs/vdev.c:3715
zero_label  cmd/zpool/zpool_vdev.c:957
zfs_create_fs  module/os/linux/zfs/zfs_znode_os.c:1970
zfs_fill_zplprops_root  module/zfs/zfs_ioctl.c:3938
zfs_ioc_pool_create  module/zfs/zfs_ioctl.c:1691
zfs_ioctl  lib/libzfs/libzfs_util.c:794
zfs_set_prop_nvlist  module/zfs/zfs_ioctl.c:3129
zio_flush  module/zfs/zio.c:1778
zio_root  module/zfs/zio.c:1093
zio_wait  module/zfs/zio.c:2841
zio_write_phys  module/zfs/zio.c:1590
zpool_create  lib/libzfs/libzfs_pool.c:1598
zpool_create_error_from_info  lib/libzfs/libzfs_pool.c:1564
zpool_do_create  cmd/zpool/zpool_main.c:1977
zpool_do_load_compat  cmd/zpool/zpool_main.c:14308
zpool_label_disk  lib/libzfs/os/linux/libzfs_pool_os.c:201
zpool_label_disk_check  lib/libzfs/os/linux/libzfs_pool_os.c:146
zpool_label_name  lib/libzfs/os/linux/libzfs_pool_os.c:177
zpool_load_compat  lib/libzfs/libzfs_pool.c:5823
zpool_prepare_and_label_disk  lib/libzfs/libzfs_util.c:2514
zpool_standard_error_fmt  lib/libzfs/libzfs_util.c:644
zpool_valid_proplist  lib/libzfs/libzfs_pool.c:577
```

## Appendix C. Wire source references

190 references for the 94 wires, at commit `c913da8615`. Each line is `<wire>  <file>:<line>  <symbol>`, and the symbol appears verbatim on that source line. A wire's references are listed in the order of the calls in its label. Return wires and error wires point at the line that performs the hand-over or raises the error.

```
E001  cmd/zpool/zpool_main.c:2134  make_root_vdev
E002  cmd/zpool/zpool_vdev.c:1701  is_grouping
E002  cmd/zpool/zpool_vdev.c:1819  make_leaf_vdev
E003  cmd/zpool/zpool_vdev.c:363  ZPOOL_CONFIG_TYPE
E003  cmd/zpool/zpool_vdev.c:385  ZPOOL_CONFIG_ASHIFT
E004  cmd/zpool/zpool_vdev.c:2197  is_device_in_use
E005  cmd/zpool/zpool_vdev.c:1225  check_device
E005  cmd/zpool/os/linux/zpool_vdev_os.c:329  efi_alloc_and_read
E005  cmd/zpool/os/linux/zpool_vdev_os.c:368  check_slice
E006  cmd/zpool/zpool_vdev.c:2207  check_replication
E007  cmd/zpool/zpool_vdev.c:2225  make_disks
E008  cmd/zpool/zpool_vdev.c:1111  zpool_prepare_and_label_disk
E008  lib/libzfs/libzfs_util.c:2528  zpool_label_disk
E009  lib/libzfs/os/linux/libzfs_pool_os.c:241  efi_alloc_and_init
E009  lib/libzfs/os/linux/libzfs_pool_os.c:302  zpool_label_name
E009  lib/libzfs/os/linux/libzfs_pool_os.c:308  efi_write
E009  lib/libzfs/os/linux/libzfs_pool_os.c:315  efi_rescan
E010  cmd/zpool/zpool_vdev.c:1132  zpool_label_disk_wait
E010  cmd/zpool/zpool_vdev.c:1141  zero_label
E011  cmd/zpool/zpool_vdev.c:1152  udevpath
E011  cmd/zpool/zpool_vdev.c:1157  update_vdev_config_dev_strs
E012  cmd/zpool/zpool_vdev.c:2064  ZPOOL_CONFIG_TYPE
E012  cmd/zpool/zpool_vdev.c:2069  ZPOOL_CONFIG_SPARES
E013  cmd/zpool/zpool_main.c:2249  zpool_do_load_compat
E013  cmd/zpool/zpool_main.c:14314  zpool_load_compat
E014  cmd/zpool/zpool_main.c:2275  nvlist_remove_all
E014  cmd/zpool/zpool_main.c:2290  add_prop_list
E015  cmd/zpool/zpool_main.c:2298  zpool_create
E016  lib/libzfs/libzfs_pool.c:1616  zcmd_write_conf_nvlist
E016  lib/libzfs/libzfs_pool.c:1621  zpool_valid_proplist
E016  lib/libzfs/libzfs_pool.c:1635  zfs_valid_proplist
E016  lib/libzfs/libzfs_pool.c:1673  ZFS_IOC_POOL_CREATE
E017  module/zfs/zfs_ioctl.c:1730  ZPOOL_ROOTFS_PROPS
E017  module/zfs/zfs_ioctl.c:1742  zfs_fill_zplprops_root
E017  module/zfs/zfs_ioctl.c:1752  spa_create
E018  module/zfs/spa.c:7322  spa_namespace_enter
E018  module/zfs/spa.c:7323  spa_lookup
E018  module/zfs/spa.c:7335  spa_add
E019  module/zfs/spa.c:7337  spa_activate
E020  module/zfs/spa.c:7339  spa_prop_validate
E021  module/zfs/spa.c:7427  spa_config_enter
E021  module/zfs/spa.c:7429  spa_config_parse
E022  module/zfs/spa.c:2071  vdev_alloc
E022  module/zfs/spa.c:2091  spa_config_parse
E023  module/zfs/vdev.c:944  vdev_op_init
E023  module/zfs/vdev_raidz.c:5628  ZPOOL_CONFIG_NPARITY
E023  module/zfs/vdev_draid.c:2500  vdev_draid_generate_perms
E024  module/zfs/spa.c:7438  vdev_create
E025  module/zfs/vdev.c:3065  vdev_open
E025  module/zfs/vdev.c:3067  VDEV_STATE_HEALTHY
E026  module/zfs/vdev.c:2256  vdev_op_open
E027  module/os/linux/zfs/vdev_disk.c:441  vdev_blkdev_get_by_path
E027  module/os/linux/zfs/vdev_disk.c:498  bdev_physical_block_size
E027  module/os/linux/zfs/vdev_disk.c:526  bdev_capacity
E028  module/os/linux/zfs/vdev_disk.c:532  physical_ashift
E028  module/zfs/vdev_file.c:180  vdev_file_logical_ashift
E029  module/zfs/vdev.c:2347  VDEV_LABEL_START_SIZE
E029  module/zfs/vdev.c:2415  vdev_ashift_optimize
E030  module/zfs/vdev.c:3076  vdev_label_init
E031  module/zfs/vdev_label.c:1296  spa_config_generate
E031  module/zfs/vdev_label.c:1339  vdev_label_write
E031  module/zfs/vdev_label.c:1357  zio_wait
E032  module/zfs/zio.c:5315  vdev_op_io_start
E033  module/zfs/vdev_label.c:169  VDEV_LABELS
E034  module/zfs/spa.c:7454  vdev_metaslab_set_size
E035  module/zfs/spa.c:7455  vdev_expand
E035  module/zfs/vdev.c:6054  vdev_config_dirty
E036  module/zfs/vdev.c:6052  vdev_metaslab_group_create
E036  module/zfs/vdev.c:1614  metaslab_group_create
E036  module/zfs/vdev.c:1618  vdev_log_mg
E037  module/zfs/vdev.c:1741  zfs_embedded_slog_min_ms
E037  module/zfs/vdev.c:1773  vdev_log_mg
E038  module/zfs/spa.c:7505  dsl_pool_create
E039  module/zfs/dsl_pool.c:497  DMU_POOL_DIRECTORY_OBJECT
E039  module/zfs/dsl_pool.c:505  dsl_dir_create_sync
E039  module/zfs/dsl_pool.c:510  MOS_DIR_NAME
E039  module/zfs/dsl_pool.c:517  FREE_DIR_NAME
E039  module/zfs/dsl_pool.c:530  dsl_pool_create_origin
E040  module/zfs/dsl_pool.c:537  spa_feature_create_zap_objects
E041  module/zfs/dsl_pool.c:544  dsl_dataset_create_sync_dd
E041  module/zfs/dsl_pool.c:550  dmu_objset_create_impl
E041  module/zfs/dsl_pool.c:554  zfs_create_fs
E042  module/zfs/spa.c:7519  dmu_tx_create_assigned
E042  module/zfs/spa.c:7525  spa_history_create_obj
E042  module/zfs/spa.c:7538  DMU_POOL_CONFIG
E042  module/zfs/spa.c:7563  bpobj_alloc
E043  module/zfs/spa.c:7586  spa_autoexpand
E043  module/zfs/spa.c:7593  spa_configfile_set
E043  module/zfs/spa.c:7594  spa_sync_props
E044  module/zfs/spa.c:10936  spa_feature_enable
E044  module/zfs/zfeature.c:462  feature_enable_sync
E045  module/zfs/spa.c:7598  SPA_FEATURE_DRAID
E045  module/zfs/spa.c:7605  SPA_FEATURE_ANYRAID
E046  module/zfs/spa.c:7607  dmu_tx_commit
E046  module/zfs/spa.c:7610  txg_sync_start
E046  module/zfs/spa.c:7612  txg_wait_synced
E047  module/zfs/txg.c:726  tx_synced_txg
E048  module/zfs/spa.c:7616  spa_write_cachefile
E049  module/zfs/spa.c:7624  SPA_LOAD_NONE
E050  module/zfs/zfs_ioctl.c:1766  zfs_set_prop_nvlist
E051  module/zfs/zfs_ioctl.c:1757  ZPOOL_CONFIG_CREATE_INFO
E051  lib/libzfs/libzfs_pool.c:1673  zfs_ioctl
E052  cmd/zpool/zpool_main.c:2303  zfs_mount
E052  cmd/zpool/zpool_main.c:2304  zfs_share
E053  module/zfs/vdev.c:2256  vdev_op_open
E054  module/zfs/vdev_mirror.c:372  vdev_open_children
E054  module/zfs/vdev_mirror.c:383  asize
E055  module/zfs/vdev.c:2256  vdev_op_open
E056  module/zfs/vdev_raidz.c:2235  vdev_open_children
E056  module/zfs/vdev_raidz.c:2265  vdev_children
E056  module/zfs/vdev_draid.c:1712  vdev_draid_open_children
E056  module/zfs/vdev_draid.c:1759  VDEV_DRAID_REFLOW_RESERVE
E057  module/zfs/spa.c:7439  vdev_draid_spare_create
E057  module/zfs/vdev_draid.c:1919  VDEV_TYPE_DRAID
E057  module/zfs/spa.c:7441  has_draid
E058  module/zfs/spa.c:7446  spa_validate_aux
E059  module/zfs/spa.c:7155  spa_config_parse
E060  module/zfs/spa.c:7167  vdev_open
E061  module/zfs/spa.c:7168  vdev_label_init
E061  module/zfs/spa.c:7169  ZPOOL_CONFIG_GUID
E061  module/zfs/spa.c:7173  vdev_free
E062  module/os/linux/zfs/vdev_disk.c:441  vdev_blkdev_get_by_path
E063  module/os/linux/zfs/vdev_disk.c:441  vdev_blkdev_get_by_path
E064  module/zfs/spa.c:7483  spa_load_spares
E064  module/zfs/spa.c:7485  sav_sync
E064  module/zfs/spa.c:7499  spa_load_l2cache
E065  module/zfs/spa.c:2553  VDEV_ALLOC_SPARE
E065  module/zfs/spa.c:2583  vdev_open
E065  module/zfs/spa.c:2587  spa_spare_add
E065  module/zfs/spa.c:2689  spa_l2cache_add
E066  module/zfs/spa.c:2702  l2arc_add_vdev
E066  module/zfs/spa.c:2711  SPA_ASYNC_L2CACHE_TRIM
E067  module/os/linux/zfs/vdev_disk.c:441  vdev_blkdev_get_by_path
E068  module/os/linux/zfs/vdev_disk.c:441  vdev_blkdev_get_by_path
E069  module/os/linux/zfs/vdev_disk.c:441  vdev_blkdev_get_by_path
E070  module/zfs/txg.c:602  spa_sync
E071  module/zfs/spa.c:11202  spa_sync_config_object
E071  module/zfs/spa.c:10805  vdev_construct_zaps
E071  module/zfs/spa.c:10807  spa_config_generate
E071  module/zfs/spa.c:10823  spa_sync_nvlist
E072  module/zfs/vdev.c:3775  vdev_zap_allocation_data
E072  module/zfs/vdev.c:3734  spa_activate_allocation_classes
E072  module/zfs/spa_misc.c:1853  spa_feature_incr
E073  module/zfs/spa.c:11203  spa_sync_aux_dev
E073  module/zfs/spa.c:10656  dmu_object_alloc
E074  module/zfs/spa.c:11208  dsl_pool_sync
E075  module/zfs/dsl_pool.c:582  dmu_objset_sync
E076  module/os/linux/zfs/vdev_disk.c:1241  vdev_disk_io_start
E077  module/os/linux/zfs/vdev_disk.c:1241  vdev_disk_io_start
E078  module/zfs/spa.c:11241  vdev_sync
E078  module/zfs/vdev.c:4441  vdev_ms_array
E078  module/zfs/metaslab.c:4412  space_map_alloc
E079  module/zfs/spa.c:11289  dmu_objset_is_dirty
E080  module/zfs/dsl_pool.c:589  spa_set_rootblkptr
E081  module/zfs/spa.c:11529  spa_sync_rewrite_vdev_config
E081  module/zfs/spa.c:11384  vdev_config_sync
E082  module/zfs/vdev_label.c:2275  uberblock_update
E082  module/zfs/vdev_label.c:2312  vdev_label_sync_list
E082  module/zfs/vdev_label.c:2345  vdev_uberblock_sync_list
E082  module/zfs/vdev_label.c:2367  vdev_label_sync_list
E083  module/zfs/vdev_label.c:213  zio_write_phys
E083  module/zfs/vdev_label.c:2215  zio_flush
E084  module/zfs/txg.c:607  tx_synced_txg
E084  module/zfs/txg.c:610  tx_sync_done_cv
E085  module/zfs/spa.c:7325  EEXIST
E086  module/zfs/spa.c:7463  spa_create_info
E087  lib/libzfs/libzfs_pool.c:1675  EBUSY
E087  lib/libzfs/libzfs_pool.c:1708  EOVERFLOW
E087  lib/libzfs/libzfs_pool.c:1783  zpool_standard_error
E087  lib/libzfs/libzfs_util.c:669  EZFS_EXISTS
E088  cmd/zpool/os/linux/zpool_vdev_os.c:318  blkid_get_tag_value
E088  cmd/zpool/zpool_vdev.c:147  POOL_STATE_ACTIVE
E088  cmd/zpool/os/linux/zpool_vdev_os.c:274  force
E088  cmd/zpool/zpool_vdev.c:2197  is_device_in_use
E089  cmd/zpool/zpool_vdev.c:537  vdev_error
E089  cmd/zpool/zpool_vdev.c:785  vdev_error
E089  cmd/zpool/zpool_vdev.c:87  is_force
E090  cmd/zpool/zpool_main.c:2136  nvroot
E091  module/zfs/spa.c:7388  zfs_special_devs
E091  module/zfs/spa.c:7466  spa_unload
E091  module/zfs/spa.c:7467  spa_deactivate
E091  module/zfs/spa.c:7468  spa_remove
E092  module/zfs/vdev.c:2341  SPA_MINDEVSIZE
E092  module/zfs/vdev.c:2344  EOVERFLOW
E092  module/zfs/vdev.c:3068  vdev_close
E093  module/zfs/vdev_label.c:1198  vdev_inuse
E093  module/zfs/vdev_label.c:1037  vdtxg
E093  module/zfs/vdev_label.c:1218  spa_create_info
E093  module/zfs/vdev_label.c:1220  EBUSY
E094  module/zfs/zfs_ioctl.c:1768  spa_destroy
E095  cmd/zpool/zpool_main.c:375  zpool_do_create
```

## Appendix D. Tunable and property source references

Where each tunable and pool property named in section 8 is declared, at commit `c913da8615`. A tunable's symbol is the name as written in its `ZFS_MODULE_PARAM` (or `ZFS_MODULE_PARAM_CALL`) line; a pool property's symbol is its quoted name in the `zprop_register_*()` call in `module/zcommon/zpool_prop.c`.

```
spa_config_path  module/zfs/spa_config.c:536  config_path
vdev_file_logical_ashift  module/zfs/vdev_file.c:366  logical_ashift
vdev_file_physical_ashift  module/zfs/vdev_file.c:368  physical_ashift
zfs_embedded_slog_min_ms  module/zfs/vdev.c:7406  embedded_slog_min_ms
zfs_vdev_default_ms_count  module/zfs/vdev.c:7359  default_ms_count
zfs_vdev_default_ms_shift  module/zfs/vdev.c:7362  default_ms_shift
zfs_vdev_max_auto_ashift  module/zfs/vdev.c:7413  max_auto_ashift
zfs_vdev_max_ms_shift  module/zfs/vdev.c:7365  max_ms_shift
zfs_vdev_min_auto_ashift  module/zfs/vdev.c:7409  min_auto_ashift
zfs_vdev_min_ms_count  module/zfs/vdev.c:7368  min_ms_count
zfs_vdev_ms_count_limit  module/zfs/vdev.c:7371  ms_count_limit
altroot  module/zcommon/zpool_prop.c:98  "altroot"
ashift  module/zcommon/zpool_prop.c:185  "ashift"
autoexpand  module/zcommon/zpool_prop.c:202  "autoexpand"
cachefile  module/zcommon/zpool_prop.c:102  "cachefile"
compatibility  module/zcommon/zpool_prop.c:108  "compatibility"
```
