# ZFS dataset creation (build spec)

This spec describes a diagram of what `zfs create` (a file system or a volume) and `zfs clone` actually do: where a new dataset sits in the pool's structure (the MOS, the tree of DSL directories, DSL datasets and their object sets), how libzfs and the kernel validate the properties, which properties are copied at create time and which are only looked up through inheritance, how quota, reservation and refreservation are checked and accounted, which txg writes the new dataset to disk, and what happens afterwards when a file system is mounted or a volume gets its block device.

Source of truth: `https://github.com/openzfs/zfs` at commit `c913da86156eba3243cc1ef515e98d69887654a7` (master, 2026-11-13, version 2.4.99). Every function name, file path and tunable in this document was checked against that commit.

## 0. Instructions to the building agent

Render this spec with the viewer in `../viewer`, as extended by `zfs-viewer-suite-spec.md`. Treat sections 6 to 10 and the appendices as data. Do not add, remove or re-route nodes and wires unless you have verified the change in the source at the pinned commit.

## 1. Goal

One page that lets an administrator answer "what does `zfs create` actually create, where does the new dataset sit inside the pool, how are its properties validated and inherited, how are quotas and reservations accounted, and what happens on mount?" by following wires between boxes.

### Mental model the diagram has to convey

1. A dataset is a set of objects in the pool's meta-object set (MOS): a DSL directory (its name in the parent's child-directory ZAP, its own props ZAP, quota, reservation and space counters) and a head DSL dataset (guid, creation txg, snapshot names, deadlist, and ds_bp, the root of the dataset's object set). The pool's root file system was created the same way at pool creation, beside the hidden $MOS, $FREE and $ORIGIN directories.
2. `zfs create` is several separate steps, not one transaction. libzfs validates names and properties and computes volume defaults; one ioctl creates the dataset in one sync task; then the remaining `-o` properties are set by further sync tasks, and if one of them fails the new dataset is destroyed again. Mounting and sharing happen afterwards in userspace, and their failure does not undo the create.
3. The create sync task runs in syncing context, in sync pass 1 of a txg, after that pass has written the MOS. It allocates the DSL objects, an empty object set with its meta-dnode, and runs the type's init: for a file system the master node, SA registry, unlinked set and root directory; for a volume its data object and size ZAP. The next sync pass writes all of it, the uberblock commits it, and only then does `zfs create` return.
4. Properties live in different places. Ordinary properties go into the new directory's props ZAP only when given with `-o`; inherited values are never copied, they are found at read time by walking up the parent directories, and a later change on an ancestor reaches mounted descendants through callbacks. The ZPL create-time properties (normalization, utf8only, casesensitivity, version) are copied from the parent's master node into the new master node and can never change. volsize and volblocksize live in the volume's own objects, the encryption parameters in its DSL Crypto Key.
5. quota and reservation belong to the DSL directory and cover descendants and snapshots; refquota and refreservation belong to the head dataset. A volume created without `-s` gets a refreservation of its size plus metadata, computed in userspace; setting it charges every ancestor at once, and an ENOSPC there makes `zfs create` fail and remove the new volume.
6. A file system appears in the namespace only when libzfs mounts it: mountpoint inherited as the parent's path plus the name, directory created, mount(2), and zfs_domount() reads the master node and registers property callbacks. A volume appears as /dev/zdN when the zvol taskq creates its block device, unless volmode=none.
7. A clone is a create whose dataset starts from a snapshot's block pointer: nothing is copied and no type init runs. Even a plain create is formally a clone of the hidden empty snapshot $ORIGIN@$ORIGIN.

### Scope

In scope: `zfs create` for file systems and volumes (`-o`, `-p`, `-V`, `-b`, `-s`, `-u`), `zfs clone`, libzfs name and property validation, volume block size and reservation defaults, the create and clone ioctls, the ZPL create-time properties, the create and clone sync tasks, the DSL directory and dataset objects, the new object set and the ZPL and zvol init, the txg that writes them, DSL property storage and inheritance, quota, reservation, refquota and refreservation checks and accounting, the mount of a new file system and the block device of a new volume.

Out of scope: encryption key handling (encryption graph, page `zfs-encryption-keys`), the zio pipeline and the uberblock write (I/O flow graph), pool creation itself, `zfs receive` creating datasets (send/receive graph), destroy, rename and promote, delegated administration (`zfs allow`), zones and user namespaces, user and project quotas, the pool history, and FreeBSD specifics.

## 2. Deliverable

The page is built by `../viewer/build_graph.py --spec specs/zfs-dataset-create-spec.md --repo zfs` and validated by `../viewer/validate_graph.py` with the same spec. Its page name is `zfs-dataset-create.html`; it belongs to the suite described in `zfs-viewer-suite-spec.md`.

## 6. Wire types and contexts

### 6.1 Wire types

The colours are the suite-wide colours of `README.md` section 6. `cfg` is reserved for this graph and the other create, import and destroy graphs.

| type id | colour | name | what travels on the wire |
|---|---|---|---|
| `cfg` | `#FFD8A8` | Configuration and properties | Property nvlists on their way from the command line to the kernel, property values read or stored (props ZAP, master node, zvol size ZAP). |
| `tx` | `#FFD43B` | Transaction | A sync task joining the open txg, or a txg being synced. |
| `bp` | `#F783AC` | Block pointer | The new object set's root block pointer. |
| `ctl` | `#868E96` | Control | Calls that carry no payload: checks, object creation, accounting, mounts. Drawn dashed. |

### 6.2 Execution contexts

| ctx id | meaning |
|---|---|
| `user` | Userspace (`zfs` command, libzfs, libzfs_core) |
| `syscall` | Kernel, in the thread of the calling process (an ioctl on /dev/zfs, mount(2) or umount(2)) or a helper thread it starts, outside syncing context and outside any dmu_tx |
| `open` | Open context: the calling thread, inside a dmu_tx |
| `sync` | Syncing context: txg_sync thread or dp_sync_taskq workers, one txg at a time (sync tasks run here) |
| `thr` | A dedicated kernel thread or zthr (here also the spa_zvol_taskq thread) |
| `any` | Runs in whichever context calls it |

## 7. Groups and default layout

Flow runs left to right: the administrator's command on the left, the kernel entry and the sync task next, then txg sync, the DSL objects, the new object set, properties and space, and finally what happens after the create.

| group id | title | colour | first column | band | sub-columns | nodes | summary |
|---|---|---|---|---|---|---|---|
| `user` | Userspace - zfs, libzfs, libzfs_core | `#5C5F66` | 0 | full | 2 | 7 | The command, name and property validation, volume defaults, the ioctl wrappers and the userspace half of mount. |
| `kentry` | Kernel entry - ioctl, checks, sync task | `#2B8A3E` | 2 | full | 2 | 8 | The create and clone ioctls, create-time checks, the sync task request and the property setting that follows it. |
| `txg` | TXG sync (shared with the I/O graph) | `#E67700` | 4 | full | 1 | 4 | The txg that runs the create task and then writes what it created. |
| `dsl` | DSL - directories and datasets in the MOS | `#1971C2` | 5 | full | 2 | 6 | The create and clone sync tasks and the DSL directory and dataset objects they add to the pool's tree. |
| `objset` | New object set and its first objects | `#D9480F` | 7 | full | 1 | 4 | The empty object set, its meta-dnode, and the ZPL or zvol objects that give it a type. |
| `props` | Properties and space | `#0C8599` | 8 | full | 2 | 5 | The props ZAP and inheritance, and the quota, reservation and space accounting of the DSL directories. |
| `after` | After create - mount and volume device | `#AE3EC9` | 10 | full | 1 | 2 | Mounting a new file system and creating the block device of a new volume. |

Default layout rules:

- Column pitch is 400 px. A group starts at `first column * 400` and is `sub-columns` columns wide. A node's x is `(group first column + node sub-col) * 400`.
- Inside a sub-column, stack nodes top to bottom in the order they appear in the section 8 tables, 28 px apart. Node height follows its socket count.
- All groups use band `full` and start at the top.
- The layout must be deterministic. Do not run a force-directed or randomised layout in the page.
- Check the default at "fit all": group titles must be readable and no node may overlap another.

## 8. Nodes

36 nodes. `sub-col` is the node's column inside its group. `functions` are real symbols at the pinned commit (locations in Appendix A); the first one is the node's headline function. Six nodes are shared with the I/O flow graph and keep its ids, titles and contexts (`dmu_tx`, `txg_sync`, `spa_sync`, `dsl_pool_sync`, `dmu_objset_sync`, `dnode`); `zfs_cmd`, `mount_lib`, `lzc`, `ioc_keys`, `dcp` and `create_crypt` are shared with the encryption graph and `sync_task` with the snapshot and send/receive graphs.

### 8.1 Userspace - zfs, libzfs, libzfs_core (`user`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `admin` | Administrator | 0 | `user` | - | - | The person or script typing the command. Every path in this graph that a command starts begins with a wire from this node; the arrows that come back into a command node are its results, errors and refusals. |
| `zfs_cmd` | zfs(8) command | 0 | `user` | `cmd/zfs/zfs_main.c` | `zfs_do_create`, `zfs_do_clone`, `parseprop`, `makeprops_parents`, `zfs_mount_and_share` | The administrator's entry points this graph follows. `zfs create`: `-o prop=value` (repeatable, kept as strings), `-V size` makes a volume, `-b` sets its volblocksize, `-s` makes it sparse, `-p` creates missing parents (`-pp` creates them with canmount=off), `-u` skips the mount, `-n` only checks. `zfs clone snap fs` takes `-o`, `-p` and `-u` the same way. After a successful create or clone it mounts and shares a file system with canmount=on; a failure there only prints a warning and the dataset stays. Properties: `canmount`. |
| `vol_defaults` | Volume defaults (-V, -b, -s) | 0 | `user` | `cmd/zfs/zfs_main.c` | `default_volblocksize`, `calculate_volblocksize`, `zvol_volsize_to_reservation`, `volsize_from_vdevs`, `zvol_auto_resv`, `zfs_create_fix_auto_resv` | Volume sizing done in userspace. volblocksize defaults to 16K, or to the largest power of 2 that fits in the pool's minimum allocation size when that is 32K or more (wide dRAID stripes, large sectors); a smaller `-b` only prints a warning. volsize is rounded up to a multiple of volblocksize. Unless `-s` or an explicit value, `zfs create` adds refreservation (reservation on pools older than version 9) of zvol_volsize_to_reservation(): volsize, scaled up when the least space-efficient raidz or dRAID top-level vdev stores the volume's blocks less efficiently than 128K blocks, times copies, plus room for the meta-dnode and every indirect block. refreservation=auto computes the same value. Properties: `volsize`, `volblocksize`, `refreservation`. |
| `mount_lib` | libzfs mount / unmount | 0 | `user` | `lib/libzfs/libzfs_mount.c` | `zfs_mount`, `zfs_mount_at`, `zfs_is_mountable`, `zfs_share`, `do_mount` | Mounting from userspace. zfs_is_mountable(): no mount for mountpoint=none or legacy, canmount=off, a zoned dataset in the global zone, or a redacted one. zfs_mount_at(): read-only if the pool is, encryption key check (encryption graph), mountpoint directory created if missing, a non-empty directory refused unless overlay=on (the default), then do_mount() calls mount(2). zfs_share() shares through libshare when sharenfs or sharesmb is set. Properties: `mountpoint`, `canmount`, `overlay`, `sharenfs`. |
| `libzfs_dscreate` | libzfs zfs_create() / zfs_clone() | 1 | `user` | `lib/libzfs/libzfs_dataset.c` | `zfs_create`, `check_parents`, `zfs_dataset_exists`, `zfs_create_ancestors_props`, `create_parents`, `zfs_clone` | Client-side checks before the ioctl. zfs_create(): the name must be valid and not too deeply nested, the pool and the parent must exist and the parent must be a file system (check_parents(), which also reads the parent's zoned property), and the dataset must not exist yet. The properties are validated; for a volume refreservation=auto is replaced by its computed size, and volsize must be present, nonzero and a multiple of volblocksize. zfs_crypto_create() adds encryption parameters if any, then lzc_create(). With `-p`, zfs_create_ancestors_props() first creates each missing ancestor as a file system and mounts it. zfs_clone() does the same checks for a clone and calls lzc_clone(). |
| `proplist` | libzfs property validation | 1 | `user` | `lib/libzfs/libzfs_dataset.c` | `zfs_valid_proplist`, `zprop_parse_value` | Turns the strings from the command line into a typed nvlist and rejects what the kernel would reject. Each name must be a known property that applies to this dataset type, a user property (a name with a colon) or a userquota@ style name. Read-only properties are refused, except set-once ones on a new dataset (normalization, utf8only, casesensitivity, volblocksize) and encryption key parameters. Values are parsed (sizes such as 10G, on and off, names such as lz4). recordsize and volblocksize must be a power of 2 from 512 bytes to the pool's maxblocksize; mountpoint must be an absolute path, none or legacy; sharenfs and sharesmb options are checked; normalization without utf8only adds utf8only=on, and normalization with utf8only=off is an error. Properties: `recordsize`, `volblocksize`, `mountpoint`, `normalization`, `utf8only`, `sharenfs`. |
| `lzc` | libzfs_core | 1 | `user` | `lib/libzfs_core/libzfs_core.c` | `lzc_create`, `lzc_clone`, `lzc_ioctl` | The thin ioctl layer. lzc_create() packs {type, props} and, for a new encryption root, the wrapping key in hidden_args; lzc_clone() packs {origin, props}; lzc_ioctl() sends the request to /dev/zfs. |

### 8.2 Kernel entry - ioctl, checks, sync task (`kentry`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `ioc_keys` | Create and key ioctls | 0 | `syscall` | `module/zfs/zfs_ioctl.c` | `zfs_ioc_create`, `zfs_ioc_clone`, `zfsdev_ioctl_common`, `zfs_secpolicy_create_clone` | Kernel entry for ZFS_IOC_CREATE and ZFS_IOC_CLONE (the encryption graph shows the same handlers carrying wrapping keys). zfsdev_ioctl_common() checks the nvlist keys and the permission policy: create and mount permission on the parent, plus clone permission on the origin for a clone. zfs_ioc_create() refuses names with @ or %, fills the ZPL create-time properties or checks the volume size, builds the crypto parameters, runs dmu_objset_create(), and only then sets the remaining properties; a property failure destroys the new dataset again. A successful call is logged to the pool history. |
| `zpl_props` | ZPL create-time properties | 0 | `syscall` | `module/zfs/zfs_ioctl.c` | `zfs_fill_zplprops`, `zfs_fill_zplprops_impl`, `zfs_get_zplprop`, `zfs_zpl_version_map` | File systems only. These are not DSL properties: zfs_fill_zplprops() takes version, normalization, utf8only, casesensitivity and the default user, group and project quotas out of the property list and puts them in zplprops for the new master node. Values not given are copied now from the parent's master node (or the default), so they are inherited once, at create time. A ZPL version above what the pool version allows, or one of these properties on a pre-normalization version, is refused with ENOTSUP. normalization forces utf8only on. casesensitivity=insensitive marks the dataset DS_FLAG_CI_DATASET. Properties: `normalization`, `utf8only`, `casesensitivity`, `version`. |
| `zvol_checks` | Volume checks | 0 | `syscall` | `module/zfs/zvol.c` | `zvol_check_volblocksize`, `zvol_check_volsize` | Kernel checks for a new volume, before anything is created: volsize must be in the property list; volblocksize (default 16K) must be a power of 2 from 512 bytes to 16M, and above 128K needs the large_blocks feature and must not exceed zfs_max_recordsize; volsize must be a nonzero multiple of volblocksize. Tunables: `zfs_max_recordsize`. Properties: `volblocksize`, `volsize`. |
| `dcp` | dsl_crypto_params | 0 | `syscall` | `module/zfs/dsl_crypt.c` | `dsl_crypto_params_create_nvlist` | Every create builds crypto parameters, with command DCP_CMD_NONE. encryption, keyformat, pbkdf2salt and pbkdf2iters are taken out of the property list here, so they never become ordinary DSL properties; without them the parameters mean "inherit from the parent". What happens with a key is in the encryption graph. |
| `set_props` | zfs_set_prop_nvlist() | 0 | `syscall` | `module/zfs/zfs_ioctl.c` | `zfs_set_prop_nvlist`, `zfs_check_settable`, `zfs_prop_set_special` | Applies the `-o` properties still in the list after the create (not volsize, volblocksize, the ZPL create-time ones or the encryption parameters). Best effort: each value's type is checked, zfs_check_settable() checks pool version and features (for example a recordsize above 128K needs large_blocks and must not exceed zfs_max_recordsize) and the set permission, and zfs_prop_set_special() hands quota, reservation, refquota, refreservation, volmode, snapdev and a few others to their own handlers (the first four are sync tasks of their own). Everything else is set in one batch. The last error is returned. Tunables: `zfs_max_recordsize`. Properties: `recordsize`. |
| `objset_create` | dmu_objset_create() / dsl_dataset_clone() | 1 | `syscall` | `module/zfs/dmu_objset.c` | `dmu_objset_create`, `dsl_dataset_clone` | Open-context wrappers that turn a create or clone request into one DSL sync task (6 blocks of MOS space, normal space check). When the task has synced they call zvol_create_minors() for the new name, so a new volume gets its block device before zfs_ioc_create() sets the remaining properties. |
| `sync_task` | dsl_sync_task() | 1 | `syscall` | `module/zfs/dsl_synctask.c` | `dsl_sync_task`, `dsl_sync_task_common`, `dsl_sync_task_sync` | Runs a metadata change in syncing context. The check function runs once in the calling thread as a quick test, the task is queued on the open txg, and the caller waits until that txg has synced. In syncing context dsl_sync_task_sync() checks pool space, re-runs the check with the pool config lock held as writer, and then calls the sync function. The create and each later property change are separate sync tasks, each with its own txg wait. |
| `dmu_tx` | dmu_tx (transaction) | 1 | `open` | `module/zfs/dmu_tx.c` | `dmu_tx_create_dd`, `dmu_tx_assign`, `dmu_tx_commit` | Shared with the I/O flow graph. Here a transaction on the MOS directory only pins the sync task to the currently open txg. |

### 8.3 TXG sync (shared with the I/O graph) (`txg`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `txg_sync` | TXG: syncing (txg_sync_thread) | 0 | `thr` | `module/zfs/txg.c` | `txg_sync_thread`, `txg_wait_synced` | Shared with the I/O flow graph. Syncs the txg the create task joined. txg_wait_synced() is why `zfs create` returns only when the new dataset is on disk. |
| `spa_sync` | spa_sync() | 0 | `sync` | `module/zfs/spa.c` | `spa_sync`, `spa_sync_iterate_to_convergence` | Shared with the I/O flow graph. Writes one txg in passes until the MOS stays clean. A new dataset needs at least two: sync tasks run only in pass 1, and the objects they create are written in pass 2. |
| `dsl_pool_sync` | dsl_pool_sync() | 0 | `sync` | `module/zfs/dsl_pool.c` | `dsl_pool_sync`, `dsl_dataset_sync`, `dsl_pool_sync_mos`, `dsl_dataset_sync_done` | Shared with the I/O flow graph. Order within a pass: the dirty datasets are written, their space deltas applied (dsl_dataset_sync_done()), the dirty DSL directories synced, the MOS written, and only then (in pass 1) the queued sync tasks run. The create task therefore dirties the MOS and the new dataset again, and the next pass writes them. |
| `dmu_objset_sync` | dmu_objset_sync() | 0 | `sync` | `module/zfs/dmu_objset.c` | `dmu_objset_sync`, `dmu_objset_write_ready`, `dmu_objset_write_done` | Shared with the I/O flow graph. Writes the new object set: its dirty dnodes (master node, root directory, SA registry and unlinked set, or the zvol objects), then the meta-dnode and the objset block. When the objset block's address is known it is copied into ds_bp of the dataset object; the MOS's own objset block address goes to the uberblock. |

### 8.4 DSL - directories and datasets in the MOS (`dsl`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `create_sync` | dmu_objset_create_check() / _sync() | 0 | `sync` | `module/zfs/dmu_objset.c` | `dmu_objset_create_check`, `dmu_objset_create_sync`, `dsl_fs_ss_limit_check` | The create sync task. Check: no @ in the name, name length and nesting depth (ENAMETOOLONG), the parent directory exists and the name does not (EEXIST), the encryption parameters fit the parent, filesystem_limit on the parent and its ancestors is not exceeded (EDQUOT), and the parent is a file system, not a volume (ZFS_ERR_WRONG_PARENT). Sync: creates the DSL objects, the object set and the type's first objects, and records "create" in the pool history. For an encrypted dataset it also writes the new object set at once, inside the task, while the key mapping is still held. Properties: `filesystem_limit`. |
| `clone_sync` | dsl_dataset_clone_check() / _sync() | 0 | `sync` | `module/zfs/dsl_dataset.c` | `dsl_dataset_clone_check`, `dsl_dataset_clone_sync`, `dsl_dataset_zero_zil` | The clone sync task. Check: as for create (name, parent, EEXIST, filesystem_limit), and the origin must be a snapshot (EINVAL). Sync: dsl_dataset_create_sync() with the snapshot as origin, then a "clone" history record. No object set is created and no type init runs: the clone's tree is the snapshot's, including its master node or zvol objects, so its create-time properties are the origin's. A non-empty ZIL header inherited from the origin is zeroed (dsl_dataset_zero_zil()), which writes the clone's object set at once. Properties: `origin`. |
| `ds_create` | dsl_dataset_create_sync() | 0 | `sync` | `module/zfs/dsl_dataset.c` | `dsl_dataset_create_sync`, `dsl_dataset_create_sync_dd`, `dsl_deleg_set_create_perms` | Creates the DSL directory first, then the head dataset object: random guid, fsid, creation time and txg, an empty snapshot-names ZAP and a deadlist. Its origin is the given snapshot for a clone, otherwise the pool's $ORIGIN@$ORIGIN, whose empty block pointer becomes ds_bp. Encryption is handed to dsl_dataset_create_crypt_sync(). The directory's head-dataset pointer is set, the creator gets the create-time permissions delegated on its ancestors (`zfs allow -c`), and with the filesystem and snapshot limit feature active the new directory starts with zero counts. |
| `dir_create` | dsl_dir_create_sync() | 1 | `sync` | `module/zfs/dsl_dir.c` | `dsl_dir_create_sync`, `dsl_fs_ss_count_adjust` | Allocates the new DSL directory object in the MOS, enters its name in the parent's child-directory ZAP, sets the parent pointer and creates its own empty props ZAP and child-directory ZAP. Where filesystem limits are tracked, the filesystem_count of every ancestor goes up by one. Nothing is copied from the parent: inherited properties are looked up at read time. |
| `dsl_tree` | DSL directory tree (MOS) | 1 | `any` | `module/zfs/dsl_dir.c` | `dsl_dir_hold`, `dsl_dir_hold_obj`, `dsl_dir_is_clone`, `dsl_pool_create`, `dsl_pool_create_origin` | Where datasets live: objects in the pool's meta-object set (MOS). The MOS object directory names the root DSL directory (root_dataset), which dsl_pool_create() made together with the hidden $MOS, $FREE and $ORIGIN directories and the pool's root file system. Each DSL directory has a child-directory ZAP (name to object number), a props ZAP, quota, reservation and used counters, and points at its head DSL dataset, whose ds_bp is the root block pointer of the dataset's object set. dsl_dir_hold() resolves pool/a/b by walking the child-directory ZAPs. $ORIGIN@$ORIGIN (pool version 11 and later) is an empty snapshot that every new file system and volume formally descends from; dsl_dir_is_clone() does not count that as a clone. |
| `create_crypt` | Encrypted dataset creation | 1 | `sync` | `module/zfs/dsl_crypt.c` | `dsl_dataset_create_crypt_sync`, `dmu_objset_create_crypt_check` | Called for every new dataset. Check (inside the create check): an unencrypted dataset may carry no key parameters; an encrypted one needs the encryption feature and either a complete new key or a parent whose key is loaded. Sync: a clone of an encrypted snapshot shares its origin's DSL Crypto Key, a dataset whose effective encryption is off returns at once, and any other gets a master key of its own. The encryption graph follows this branch. Properties: `encryption`. |

### 8.5 New object set and its first objects (`objset`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `objset_init` | dmu_objset_create_impl() | 0 | `sync` | `module/zfs/dmu_objset.c` | `dmu_objset_create_impl`, `dmu_objset_create_impl_dnstats`, `dsl_dataset_dirty` | Turns the empty block pointer into a live object set: opens it from the dataset (a hole, so nothing is read), allocates the meta-dnode (16K blocks of dnodes, 128K indirect blocks) with enough levels for every possible object, so that it never has to gain a level later, sets os_type to ZFS or ZVOL, and marks user, group and project accounting complete when those features are enabled. dsl_dataset_dirty() queues the dataset to be written in this txg. The MOS itself was made by the same function at pool creation. |
| `zpl_init` | ZPL init: master node and root directory | 0 | `sync` | `module/os/linux/zfs/zfs_znode_os.c` | `zfs_create_cb`, `zfs_create_fs` | What makes an object set a file system. zfs_create_fs() claims object 1 as the master node ZAP and stores the zplprops in it (normalization, utf8only, casesensitivity, default quotas) and the ZPL version (the requested one if lower than the pool allows). With ZPL version 5 (system attributes) it creates the SA attribute registry; it always creates the unlinked set (files removed while still open) and, with zfs_mknode(), the root directory: mode 0755, owned by the uid and gid of the creating process. Their object numbers go into the master node. dsl_pool_create() runs zfs_create_fs() for the pool's root file system too. |
| `zvol_init` | zvol_create_cb() | 0 | `sync` | `module/zfs/zvol.c` | `zvol_create_cb` | What makes an object set a volume: object 1 (DMU_OT_ZVOL) holds the data, with volblocksize as its block size, and object 2 is a ZAP whose "size" entry is volsize. Both values are removed from the property list here, so they are never stored as DSL properties; `zfs get` reads them back from these objects. No data block is written: the volume is all holes until written. Properties: `volsize`, `volblocksize`. |
| `dnode` | dnode (object) | 0 | `any` | `module/zfs/dnode.c` | `dnode_allocate`, `dnode_setdirty`, `dmu_object_alloc`, `dmu_object_claim`, `zap_create_claim` | Shared with the I/O flow graph. Every object the create makes is a dnode allocated in syncing context: dmu_object_alloc() and its variants (also used by zap_create()) for the new MOS objects (DSL directory, DSL dataset, their ZAPs), dmu_object_claim() and zap_create_claim() for the fixed object numbers inside the new object set (master node, zvol objects), and dnode_allocate() directly for the meta-dnode. dnode_allocate() calls dnode_setdirty(), which puts the dnode on its object set's dirty list for this txg and dirties the dataset. |

### 8.6 Properties and space (`props`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `props_set` | dsl_props_set() | 0 | `sync` | `module/zfs/dsl_prop.c` | `dsl_props_set`, `dsl_props_set_check`, `dsl_props_set_sync`, `dsl_prop_set_sync_impl` | Sets a batch of ordinary properties all-or-nothing, as one sync task (space for 2 blocks per property, reserved-space check). Check: name and string value lengths. Sync: for a local value dsl_prop_set_sync_impl() writes propname into the props ZAP and removes any propname$inherit entry; integer properties are pushed to the callbacks of open datasets that inherit them; each change is recorded in the pool history. |
| `quota` | quota / reservation (dsl_dir) | 0 | `sync` | `module/zfs/dsl_dir.c` | `dsl_dir_set_quota`, `dsl_dir_set_quota_check`, `dsl_dir_set_quota_sync`, `dsl_dir_set_reservation`, `dsl_dir_set_reservation_check`, `dsl_dir_set_reservation_sync_impl` | Space limits of a DSL directory: they cover the dataset, its snapshots and all its descendants. Each is its own sync task with the extra-reserved space check. quota: a new quota below the reservation or below the space already used plus pending writes fails with ENOSPC. reservation: checked only in syncing context; its growth must fit in what the parent can still provide and stay within the quota (ENOSPC). The value goes to the props ZAP and to dd_quota or dd_reserved. The part of a reservation above the space used is charged to the parent as reserved child space (part of usedbychildren), and from there up the tree, so siblings see less available space. Properties: `quota`, `reservation`. |
| `refquota` | refquota / refreservation (dsl_dataset) | 0 | `sync` | `module/zfs/dsl_dataset.c` | `dsl_dataset_set_refquota`, `dsl_dataset_set_refquota_check`, `dsl_dataset_set_refreservation`, `dsl_dataset_set_refreservation_check`, `dsl_dataset_set_refreservation_sync_impl` | Limits of the head dataset alone, not its snapshots or descendants. refquota: refused below the bytes the dataset already references or below its refreservation (ENOSPC); cached as ds_quota. refreservation: checked in syncing context; the part not already covered by the dataset's unique bytes must fit in the space available to its directory and must not exceed refquota (ENOSPC). That part is charged at once as usedbyrefreservation (DD_USED_REFRSRV), which counts in the used of every ancestor; later writes are absorbed by it instead of growing the parents' used. For a thick volume this is how its whole size is set aside at create time. Properties: `refquota`, `refreservation`. |
| `props_zap` | DSL props ZAP and inheritance | 1 | `any` | `module/zfs/dsl_prop.c` | `dsl_prop_get_dd`, `dsl_prop_get_ds`, `dsl_prop_register`, `dsl_prop_changed_notify`, `dsl_prop_get_integer` | Each DSL directory's props ZAP holds only what was set on it: propname for a local value, propname$recvd for a received one, propname$inherit for an explicit inherit over a received value. A new dataset's ZAP starts empty, so every property it did not get with `-o` is inherited. Reading a value (dsl_prop_get_dd()) looks in this directory, then in each parent up to the root, and falls back to the default; where it was found is the source `zfs get` shows. Non-inheritable properties are looked up in this directory only. dsl_prop_register() reads a value and keeps a callback; when a value is set on an ancestor, dsl_prop_changed_notify() walks the child directories, skips any subtree that sets the property itself, and calls the callbacks. |
| `dir_space` | dsl_dir space accounting | 1 | `any` | `module/zfs/dsl_dir.c` | `dsl_dir_space_available`, `dsl_dir_diduse_space`, `dsl_dir_diduse_space_impl`, `dsl_dataset_apply_deltas` | Each DSL directory tracks its used bytes (broken down into head, snapshots, children, refreservation and child reservations), its quota and its reservation. Changes are applied in syncing context and rolled up into every ancestor, adjusted so that space inside a reservation is not counted twice. dsl_dir_space_available() is what a check sees: the smaller of what the parent can provide (plus this directory's unused reservation) and the room left under its own quota, capped by the pool size at the root. A new dataset starts with only its first metadata blocks charged. |

### 8.7 After create - mount and volume device (`after`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `zpl_mount` | zpl mount (zfs_domount) | 0 | `syscall` | `module/os/linux/zfs/zfs_vfsops.c` | `zfs_domount`, `zpl_get_tree`, `zfsvfs_create`, `zfsvfs_init`, `zfsvfs_setup`, `zfs_register_callbacks` | Kernel side of mount(2) on Linux. zpl_get_tree() holds the dataset and finds or creates the superblock; zfs_domount() creates the zfsvfs, which owns the object set (zfsvfs_create()) and reads the master node (zfsvfs_init()); the superblock block size is recordsize. zfsvfs_setup() registers the property callbacks, opens the ZIL, drains the unlinked set and replays any intent log (there is none on a new file system); zfs_root() then gets the root directory inode. An encrypted dataset needs its key here (encryption graph). Properties: `recordsize`. |
| `zvol_newdev` | zvol device node | 0 | `thr` | `module/zfs/zvol.c` | `zvol_create_minors`, `zvol_task_cb`, `zvol_create_minors_impl`, `zvol_os_create_minor`, `zvol_alloc` | Creates block devices for volumes on the spa_zvol_taskq while the caller waits. zvol_create_minors_impl() searches the name and its children for volumes and, with snapdev=visible, their snapshots. On Linux zvol_os_create_minor() owns the volume, reads its size and block size, allocates the zvol state and gendisk, replays its ZIL and adds the disk, which appears as /dev/zdN (16 minors per volume, for partitions); the udev rule 60-zvol.rules adds the /dev/zvol/pool/name link. volmode=none, or the zvol_inhibit_dev tunable, means no device. This runs before zfs_ioc_create() sets the `-o` properties, so a volmode or snapdev given at create is applied afterwards by its own handler. Tunables: `zvol_inhibit_dev`, `zvol_prefetch_bytes`, `zvol_volmode`. Properties: `volmode`, `snapdev`. |

## 9. Wires

64 wires. A wire runs from the node that hands something over to the node that receives it. Returns from function calls are mostly not drawn. `on paths` lists the section 10 paths that use the wire.

| wire | from | to | type | label | on paths |
|---|---|---|---|---|---|
| E001 | `zfs_cmd` | `libzfs_dscreate` | `ctl` | zfs create: zfs_do_create() collects each -o prop=value as a string (parseprop()) and calls zfs_create(name, file system or volume, props) | create_fs, create_parents, props |
| E002 | `zfs_cmd` | `proplist` | `cfg` | -V size (or -n): zfs_do_create() validates the list early with zfs_valid_proplist(), which also resolves aliases such as refreserv | create_vol |
| E003 | `proplist` | `vol_defaults` | `cfg` | default_volblocksize(): the pool's minimum allocation size (ZPOOL_CONFIG_MAX_ALLOC or the vdev tree) sets the default volblocksize, 16K or more; volsize is rounded up to a multiple of it | create_vol |
| E004 | `vol_defaults` | `libzfs_dscreate` | `cfg` | volblocksize added to props when it is not 16K; unless -s or given explicitly, refreservation (reservation before pool version 9) = zvol_volsize_to_reservation(), volsize scaled by volsize_from_vdevs() plus indirect blocks of up to 128K; then zfs_create() | create_vol |
| E005 | `libzfs_dscreate` | `proplist` | `cfg` | zfs_create(): zfs_validate_name() and dataset_nestcheck(), then check_parents() (pool and parent exist, parent is a file system, read its zoned value), then zfs_valid_proplist(type, props, zoned) | create_fs, create_vol, create_parents, props |
| E006 | `proplist` | `libzfs_dscreate` | `cfg` | typed nvlist: values parsed by zprop_parse_value(), read-only properties refused unless set-once at create, recordsize and volblocksize powers of 2 up to maxblocksize, normalization forces utf8only; zfs_create() then resolves refreservation=auto and checks volsize | create_fs, create_vol, create_parents, props |
| E007 | `libzfs_dscreate` | `lzc` | `cfg` | zfs_crypto_create() (nothing to add unless encryption is set or inherited), then lzc_create(name, ZFS or ZVOL, props, wrapping key) | create_fs, create_vol, create_parents, props |
| E008 | `lzc` | `ioc_keys` | `cfg` | ioctl ZFS_IOC_CREATE with {type, props, hidden_args}; zfsdev_ioctl_common(): zfs_check_input_nvpairs(), then zfs_secpolicy_create_clone() (create and mount permission on the parent), then zfs_ioc_create() | create_fs, create_vol, create_parents, props |
| E009 | `ioc_keys` | `zpl_props` | `cfg` | file system: zfs_fill_zplprops() holds the parent's objset, removes version, normalization, utf8only, casesensitivity and the default quotas from props, copies missing ones from the parent's master node (zfs_get_zplprop()); a volume as parent fails with ZFS_ERR_WRONG_PARENT | create_fs, props, inherit |
| E010 | `ioc_keys` | `zvol_checks` | `ctl` | volume: zvol_check_volblocksize() (above 128K needs large_blocks and at most zfs_max_recordsize) and zvol_check_volsize() (nonzero multiple of volblocksize) | create_vol |
| E011 | `ioc_keys` | `dcp` | `cfg` | dsl_crypto_params_create_nvlist(DCP_CMD_NONE, props, hidden_args): encryption, keyformat, pbkdf2salt and pbkdf2iters leave the property list | create_fs, create_vol, props |
| E012 | `dcp` | `objset_create` | `cfg` | callback zfs_create_cb() or zvol_create_cb(); dmu_objset_create(name, type, DS_FLAG_CI_DATASET if case-insensitive, dcp, callback, zct with props and zplprops) | create_fs, create_vol, props |
| E013 | `objset_create` | `sync_task` | `tx` | dsl_sync_task() with dmu_objset_create_check() and dmu_objset_create_sync() (a clone: dsl_dataset_clone_check() and dsl_dataset_clone_sync()), 6 blocks; the check runs first in the calling thread | create_fs, create_vol, txg_write, clone |
| E014 | `sync_task` | `dmu_tx` | `tx` | dmu_tx_create_dd() + dmu_tx_assign(): the task is added to the open txg's dp_sync_tasks list; dmu_tx_commit() | create_fs, create_vol, txg_write, clone |
| E015 | `sync_task` | `txg_sync` | `ctl` | txg_wait_synced(): the caller sleeps until that txg is on disk | create_fs, create_vol, txg_write, clone |
| E016 | `txg_sync` | `spa_sync` | `tx` | txg_sync_thread() -> spa_sync(txg) | create_fs, create_vol, txg_write, clone |
| E017 | `spa_sync` | `dsl_pool_sync` | `tx` | spa_sync_iterate_to_convergence(): dsl_pool_sync() in each pass until the MOS is no longer dirty | create_fs, create_vol, txg_write, clone |
| E018 | `dsl_pool_sync` | `create_sync` | `ctl` | pass 1, after dsl_pool_sync_mos(): dsl_sync_task_sync() checks pool space (6 blocks, times 3 for the MOS), re-runs dmu_objset_create_check() with the config lock held as writer, then calls dmu_objset_create_sync() | create_fs, create_vol, txg_write |
| E019 | `create_sync` | `dsl_tree` | `ctl` | check: dsl_dir_hold() walks the child-directory ZAPs down to the deepest existing directory, the parent; ENOENT if more than the last component is missing, EEXIST if nothing is; dsl_fs_ss_limit_check() for filesystem_limit (EDQUOT); a volume as parent gives ZFS_ERR_WRONG_PARENT | create_fs, txg_write |
| E020 | `create_sync` | `ds_create` | `ctl` | dmu_objset_create_sync(): dsl_dir_hold() again, then dsl_dataset_create_sync(parent directory, last component, no origin, flags, cred, dcp) | create_fs, create_vol, txg_write |
| E021 | `ds_create` | `dir_create` | `ctl` | dsl_dir_create_sync(): the directory comes first | create_fs, create_vol, txg_write, clone |
| E022 | `dir_create` | `dsl_tree` | `ctl` | dmu_object_alloc() of a DSL directory object in the MOS; its name is added to the parent's child-directory ZAP; filesystem_count goes up where limits are tracked; empty props ZAP and child-directory ZAP created | create_fs, create_vol, txg_write, clone |
| E023 | `ds_create` | `dsl_tree` | `ctl` | dsl_dataset_create_sync_dd(): origin defaults to $ORIGIN@$ORIGIN; dmu_object_alloc() of the dataset object with a random guid and an empty snapshot-names ZAP; ds_prev_snap_obj is the origin and ds_bp its empty block pointer; dd_head_dataset_obj set; dsl_deleg_set_create_perms() | create_fs, create_vol, txg_write |
| E024 | `ds_create` | `create_crypt` | `ctl` | dsl_dataset_create_crypt_sync(): a clone shares its origin's key object (dsl_dir_is_clone()); with encryption off it returns at once; otherwise a new key object (encryption graph) | create_fs, clone |
| E025 | `create_sync` | `objset_init` | `ctl` | dsl_dataset_hold_obj_flags(DS_HOLD_FLAG_DECRYPT), then dmu_objset_create_impl(spa, ds, ds_bp, type) | create_fs, create_vol, txg_write |
| E026 | `objset_init` | `dnode` | `ctl` | dnode_allocate() of the meta-dnode with enough levels for DN_MAX_OBJECT objects; os_type set to ZFS or ZVOL; accounting flags such as OBJSET_FLAG_USERACCOUNTING_COMPLETE set | create_fs, create_vol, txg_write |
| E027 | `objset_init` | `dsl_pool_sync` | `tx` | dsl_dataset_dirty(): the new dataset joins this txg's dp_dirty_datasets, so the next sync pass writes it | create_fs, create_vol, txg_write |
| E028 | `create_sync` | `zpl_init` | `ctl` | file system: doca_userfunc is zfs_create_cb() -> zfs_create_fs(os, cred, zplprops, tx) | create_fs |
| E029 | `zpl_props` | `zpl_init` | `cfg` | zplprops ride in zct to the callback: each value is stored with zap_update() in the master node, the version as ZPL_VERSION_STR | create_fs, props, inherit |
| E030 | `zpl_init` | `dnode` | `ctl` | zap_create_claim() of object 1, the master node; zap_create() for the SA registry (DMU_OT_SA_MASTER_NODE) and the unlinked set (DMU_OT_UNLINKED_SET); root directory S_IFDIR 0755 by zfs_mknode(), recorded as ZFS_ROOT_OBJ; each new dnode is dirtied with dnode_setdirty() | create_fs |
| E031 | `create_sync` | `zvol_init` | `ctl` | volume: doca_userfunc is zvol_create_cb() | create_vol |
| E032 | `zvol_init` | `dnode` | `ctl` | volsize and volblocksize removed from props (they never become DSL properties); dmu_object_claim() of object 1 (DMU_OT_ZVOL, block size volblocksize); zap_create_claim() of object 2; its size entry set to volsize with zap_update() | create_vol |
| E033 | `dsl_pool_sync` | `dmu_objset_sync` | `tx` | next pass: dsl_dataset_sync() -> dmu_objset_sync() writes the new dnodes and then the objset block with arc_write(); dsl_pool_sync_mos() writes the new MOS objects | create_fs, create_vol, txg_write |
| E034 | `dmu_objset_sync` | `dsl_tree` | `bp` | dmu_objset_write_ready(): the objset block's address is copied to os_rootbp, which is ds_bp of the dataset object; the MOS root block pointer goes to spa_set_rootblkptr() and the uberblock | create_fs, txg_write |
| E035 | `dsl_pool_sync` | `dir_space` | `ctl` | dmu_objset_write_done() -> dsl_dataset_block_born() counts the new blocks; dsl_dataset_sync_done() -> dsl_dataset_apply_deltas() adds them to the dataset and dsl_dir_diduse_transfer_space() rolls the used bytes up the tree | txg_write |
| E036 | `objset_create` | `zvol_newdev` | `ctl` | after the task: zvol_create_minors(name) dispatches a task to spa_zvol_taskq and waits for it (taskq_wait_id()); a file system has no volumes, so no device is made | create_vol |
| E037 | `zvol_newdev` | `props_zap` | `cfg` | dsl_prop_get_integer(): snapdev, then in zvol_alloc() volmode (default means the zvol_volmode tunable, ZFS_VOLMODE_NONE means no device) and volthreading | create_vol |
| E038 | `zvol_newdev` | `zvol_init` | `cfg` | zvol_os_create_minor(): dmu_objset_own(), volsize from ZVOL_ZAP_OBJ and volblocksize from object 1, zvol_alloc(), zil_open() and replay, dmu_prefetch() of the first and last zvol_prefetch_bytes, zvol_os_add_disk(): /dev/zdN appears; udev runs zvol_id to add /dev/zvol/pool/name | create_vol |
| E039 | `ioc_keys` | `set_props` | `cfg` | after dmu_objset_create() (or dsl_dataset_clone()) has returned: zfs_set_prop_nvlist(name, ZPROP_SRC_LOCAL, props) | create_fs, create_vol, create_parents, props, inherit, quota_resv, clone |
| E040 | `set_props` | `ioc_keys` | `ctl` | a property failed: zfs_ioc_create() removes the new dataset with dsl_destroy_head() (a volume after its zvol tasks finish) and the create fails | props, quota_resv |
| E041 | `set_props` | `quota` | `ctl` | zfs_check_settable(), then zfs_prop_set_special(): quota -> dsl_dir_set_quota(), reservation -> dsl_dir_set_reservation(), each its own sync task | props, quota_resv |
| E042 | `set_props` | `refquota` | `ctl` | refquota -> dsl_dataset_set_refquota(), refreservation -> dsl_dataset_set_refreservation(), each its own sync task | create_vol, props, quota_resv |
| E043 | `set_props` | `props_set` | `cfg` | a special property that failed is retried once after the others (retrynvl); all ordinary ones are set in one batch: dsl_props_set(name, local, genericnvl) | create_fs, props, inherit |
| E044 | `props_set` | `props_zap` | `cfg` | dsl_sync_task() -> dsl_props_set_sync_impl() -> dsl_prop_set_sync_impl(): in dd_props_zapobj any propname$inherit entry is removed and propname is set with zap_update(); dsl_prop_changed_notify() for integer properties | create_fs, props, inherit |
| E045 | `quota` | `dir_space` | `ctl` | quota below dd_used_bytes plus pending writes or below the reservation: ENOSPC; reservation growth beyond dsl_dir_space_available() of the parent or above quota: ENOSPC; in sync the reservation above used is charged to the parent as DD_USED_CHILD_RSRV | quota_resv |
| E046 | `quota` | `props_zap` | `cfg` | dsl_prop_set_sync_impl() stores the value in the props ZAP; dd_quota or dsl_dir_set_reservation_sync_impl() updates the directory | props, quota_resv |
| E047 | `refquota` | `dir_space` | `ctl` | refreservation: the part not covered by unique bytes must fit in dsl_dir_space_available() (ENOSPC otherwise); in sync ds_reserved is set and that part is charged as DD_USED_REFRSRV, rolled up by dsl_dir_diduse_transfer_space_impl() | create_vol, quota_resv |
| E048 | `refquota` | `props_zap` | `cfg` | refquota below ds_referenced_bytes or below refreservation is refused; in sync it is stored and cached as ds_quota; refreservation is stored with dsl_prop_set_sync_impl() | create_vol, props, quota_resv |
| E049 | `zfs_cmd` | `mount_lib` | `ctl` | unless -u: zfs_mount_and_share(); a ZFS_TYPE_VOLUME is skipped; with ZFS_CANMOUNT_ON zfs_mount() then zfs_share(); failures only warn | create_fs, create_vol, create_parents, inherit, mount, clone |
| E050 | `mount_lib` | `props_zap` | `cfg` | zfs_is_mountable() reads ZFS_PROP_MOUNTPOINT from the values ZFS_IOC_OBJSET_STATS returned (dsl_prop_get_all() with sources); an inherited mountpoint gets the path below the source dataset appended (relpath); none, ZFS_MOUNTPOINT_LEGACY or ZFS_CANMOUNT_OFF means no mount | inherit, mount |
| E051 | `mount_lib` | `zpl_mount` | `ctl` | zfs_mount_at(): mkdirp() of the mountpoint (0755), ZFS_PROP_OVERLAY decides whether a non-empty directory (dir_is_empty()) is refused; do_mount() -> mount(2) type MNTTYPE_ZFS; in the kernel zpl_get_tree() -> zfs_domount() | create_parents, inherit, mount |
| E052 | `zpl_mount` | `zpl_init` | `cfg` | zfsvfs_create() -> dmu_objset_own(); zfsvfs_init() reads the master node: ZFS_PROP_VERSION (ENOTSUP if newer than the pool allows), normalization, utf8only, casesensitivity, ZFS_ROOT_OBJ and the unlinked set | inherit, mount |
| E053 | `zpl_mount` | `props_zap` | `cfg` | dsl_prop_get_integer() for recordsize (superblock block size); zfsvfs_setup() -> zfs_register_callbacks(): dsl_prop_register() for atime, recordsize (blksz_changed_cb), readonly, xattr and others reads each value via dsl_prop_get_int_ds() and calls its callback now and on every later change | inherit, mount |
| E054 | `zfs_cmd` | `libzfs_dscreate` | `ctl` | -p: makeprops_parents() (-pp: ZFS_PROP_CANMOUNT off for the ancestors); an existing target makes zfs create -p succeed at once (zfs_dataset_exists()); zfs_create_ancestors_props() | create_parents |
| E055 | `libzfs_dscreate` | `mount_lib` | `ctl` | check_parents() finds the deepest existing ancestor; create_parents() then, for each missing one in turn, zfs_create(), zfs_mount() (nothing with canmount=off) and zfs_share() | create_parents |
| E056 | `zfs_cmd` | `libzfs_dscreate` | `ctl` | zfs clone snap fs: zfs_do_clone() opens the ZFS_TYPE_SNAPSHOT (with -p, zfs_create_ancestors_props() first) and calls zfs_clone() | clone |
| E057 | `libzfs_dscreate` | `lzc` | `cfg` | zfs_clone(): check_parents(), zfs_valid_proplist() for the origin's type, zfs_crypto_clone_check(), then lzc_clone(name, origin, props) | clone |
| E058 | `lzc` | `ioc_keys` | `cfg` | ioctl ZFS_IOC_CLONE with {origin, props}; zfs_secpolicy_create_clone() also needs ZFS_DELEG_PERM_CLONE on the origin | clone |
| E059 | `ioc_keys` | `objset_create` | `ctl` | zfs_ioc_clone() -> dsl_dataset_clone(name, origin): no ZPL or volume properties are filled in and no type callback is passed | clone |
| E060 | `dsl_pool_sync` | `clone_sync` | `ctl` | dsl_sync_task_sync(): dst_checkfunc dsl_dataset_clone_check() (filesystem_limit with dsl_fs_ss_limit_check(), origin must be a snapshot: ds_is_snapshot), then dst_syncfunc dsl_dataset_clone_sync() | clone |
| E061 | `clone_sync` | `ds_create` | `ctl` | dsl_dataset_create_sync(parent directory, last component, origin snapshot) | clone |
| E062 | `ds_create` | `dsl_tree` | `ctl` | clone: ds_bp and referenced bytes copied from the origin snapshot (no block is copied); origin's ds_num_children incremented, clone added to its ds_next_clones_obj; dd_origin_obj set; DD_FIELD_LIVELIST added when enabled; dsl_dataset_zero_zil() | clone |
| E063 | `admin` | `zfs_cmd` | `ctl` | runs zfs create [-p] [-o property=value] filesystem, or zfs create [-s] [-b blocksize] -V size volume | create_fs, create_vol, create_parents, props, mount |
| E064 | `admin` | `zfs_cmd` | `ctl` | runs zfs clone [-p] [-o property=value] snapshot filesystem | clone |

## 10. Paths

9 named paths, 157 steps in total. Each step is one wire; the caption for a step is that wire's label. Every wire in section 9 is on at least one path. The category is the heading the path is listed under in the left panel. Path syntax, alternatives and notes are defined in section 10 of `../zfs-io-flow-diagram-spec.md`.

### 10.1 `create_fs` - Create a file system (zfs create pool/fs)

Category: Create. `zfs create -o compression=lz4 tank/home`: from the command line through one sync task that adds the DSL directory, the DSL dataset and a new object set with a master node and root directory, to the property batch and the mount.

Alternatives:
- `crypt`: `plain` Unencrypted (dsl_dataset_create_crypt_sync() returns at once, no steps of its own); `enc` Encrypted, given encryption=on or an encrypted parent

```
 1  E063  admin -> zfs_cmd
 2  E001  zfs_cmd -> libzfs_dscreate
 3  E005  libzfs_dscreate -> proplist
 4  E006  proplist -> libzfs_dscreate
 5  E007  libzfs_dscreate -> lzc
 6  E008  lzc -> ioc_keys
 7  E009  ioc_keys -> zpl_props
 8  E011  ioc_keys -> dcp
 9  E012  dcp -> objset_create
10  E013  objset_create -> sync_task
11  E014  sync_task -> dmu_tx
12  E015  sync_task -> txg_sync
13  E016  txg_sync -> spa_sync
14  E017  spa_sync -> dsl_pool_sync
15  E018  dsl_pool_sync -> create_sync
16  E019  create_sync -> dsl_tree
17  E020  create_sync -> ds_create
18  E021  ds_create -> dir_create
19  E022  dir_create -> dsl_tree
20  E023  ds_create -> dsl_tree
21  E024  ds_create -> create_crypt  [crypt: enc]  "a new master key, or the parent's encryption root wraps it: path zfs-encryption-keys:create"
22  E025  create_sync -> objset_init
23  E026  objset_init -> dnode
24  E028  create_sync -> zpl_init
25  E029  zpl_props -> zpl_init
26  E030  zpl_init -> dnode
27  E027  objset_init -> dsl_pool_sync
28  E033  dsl_pool_sync -> dmu_objset_sync
29  E034  dmu_objset_sync -> dsl_tree
30  E039  ioc_keys -> set_props
31  E043  set_props -> props_set  "compression has a special handler, but it needs a sync task only for zstd (to activate the feature); lz4 joins the batch"
32  E044  props_set -> props_zap
33  E049  zfs_cmd -> mount_lib  "continue with path mount"
```
Ends: tank/home exists on disk with an empty root directory owned by the creating user; its props ZAP holds only compression; everything else is inherited from tank. For an encrypted file system the key part is `zfs-encryption-keys:create`.

### 10.2 `create_vol` - Create a volume (zfs create -V)

Category: Create. `zfs create -V 10G tank/vol`: userspace picks the block size and, unless `-s`, a refreservation; the kernel checks the sizes, creates an object set holding the volume's data object and size ZAP, makes the block device, and only then sets the refreservation.

Alternatives:
- `resv`: `thick` Default: refreservation of the full size plus metadata; `sparse` zfs create -s: no refreservation (thin provisioned)

```
 1  E063  admin -> zfs_cmd
 2  E002  zfs_cmd -> proplist
 3  E003  proplist -> vol_defaults
 4  E004  vol_defaults -> libzfs_dscreate  [resv: thick]
 5  E004  vol_defaults -> libzfs_dscreate  [resv: sparse]  "-s: no refreservation is added; only volsize and volblocksize go on"
 6  E005  libzfs_dscreate -> proplist  "zfs_create() validates the list again"
 7  E006  proplist -> libzfs_dscreate
 8  E007  libzfs_dscreate -> lzc
 9  E008  lzc -> ioc_keys
10  E010  ioc_keys -> zvol_checks
11  E011  ioc_keys -> dcp
12  E012  dcp -> objset_create
13  E013  objset_create -> sync_task
14  E014  sync_task -> dmu_tx
15  E015  sync_task -> txg_sync
16  E016  txg_sync -> spa_sync
17  E017  spa_sync -> dsl_pool_sync
18  E018  dsl_pool_sync -> create_sync
19  E020  create_sync -> ds_create
20  E021  ds_create -> dir_create
21  E022  dir_create -> dsl_tree
22  E023  ds_create -> dsl_tree
23  E025  create_sync -> objset_init
24  E026  objset_init -> dnode
25  E031  create_sync -> zvol_init
26  E032  zvol_init -> dnode
27  E027  objset_init -> dsl_pool_sync
28  E033  dsl_pool_sync -> dmu_objset_sync
29  E036  objset_create -> zvol_newdev
30  E037  zvol_newdev -> props_zap
31  E038  zvol_newdev -> zvol_init
32  E039  ioc_keys -> set_props
33  E042  set_props -> refquota  [resv: thick]
34  E047  refquota -> dir_space  [resv: thick]  "the whole reservation is charged to tank and every ancestor now; ENOSPC here removes the new volume (path quota_resv)"
35  E048  refquota -> props_zap  [resv: thick]
36  E049  zfs_cmd -> mount_lib  "a volume is not mounted"
```
Ends: /dev/zdN and /dev/zvol/tank/vol exist; the volume is all holes. A thick volume has its full size set aside in the space accounting of every ancestor; a sparse one uses space only as it is written. I/O to the device follows `zfs-io-flow:zvol_write`.

### 10.3 `create_parents` - zfs create -p: missing parents first

Category: Create. `zfs create -p tank/a/b/c` when only tank exists. Each missing ancestor is a complete create of its own (path create_fs), with its own ioctl and txg, followed by a mount; the operation as a whole is not atomic.

Alternatives:
- `pp`: `mount` -p: ancestors are ordinary file systems and are mounted; `nomount` -pp: ancestors get canmount=off and are not mounted

```
 1  E063  admin -> zfs_cmd
 2  E054  zfs_cmd -> libzfs_dscreate
 3  E005  libzfs_dscreate -> proplist  "zfs_create() for the first missing ancestor, tank/a"
 4  E006  proplist -> libzfs_dscreate
 5  E007  libzfs_dscreate -> lzc  "one complete create per missing ancestor, as in path create_fs"
 6  E008  lzc -> ioc_keys
 7  E039  ioc_keys -> set_props  [pp: nomount]  "canmount=off is the only property of each ancestor"
 8  E055  libzfs_dscreate -> mount_lib
 9  E051  mount_lib -> zpl_mount  [pp: mount]
10  E001  zfs_cmd -> libzfs_dscreate  "then the target tank/a/b/c itself, as in path create_fs, with the -o properties"
11  E049  zfs_cmd -> mount_lib
```
Ends: tank/a, tank/a/b and tank/a/b/c exist. If a later step fails, the ancestors already created stay. With -pp the ancestors exist only as containers for properties and children.

### 10.4 `props` - Where each -o property goes

Category: Properties. `zfs create -o casesensitivity=insensitive -o quota=10G -o refreservation=1G -o atime=off tank/share`: the same command line ends up in four different places, at different times.

Alternatives:
- `outcome`: `ok` Every property is set; `fail` One property fails (for example quota below the reservation): the new dataset is destroyed

```
 1  E063  admin -> zfs_cmd
 2  E001  zfs_cmd -> libzfs_dscreate
 3  E005  libzfs_dscreate -> proplist
 4  E006  proplist -> libzfs_dscreate
 5  E007  libzfs_dscreate -> lzc
 6  E008  lzc -> ioc_keys
 7  E009  ioc_keys -> zpl_props  "casesensitivity leaves the list here"
 8  E029  zpl_props -> zpl_init  "and is written into the new master node by the create task"
 9  E011  ioc_keys -> dcp  "encryption parameters would leave the list here"
10  E012  dcp -> objset_create  "the create itself runs as in path create_fs"
11  E039  ioc_keys -> set_props  "quota, refreservation and atime are still in the list"
12  E041  set_props -> quota
13  E042  set_props -> refquota
14  E043  set_props -> props_set
15  E044  props_set -> props_zap
16  E046  quota -> props_zap  [outcome: ok]
17  E048  refquota -> props_zap  [outcome: ok]
18  E040  set_props -> ioc_keys  [outcome: fail]
```
Ends: casesensitivity is in the master node and can never change; quota is in the props ZAP and dd_quota; refreservation in the props ZAP and ds_reserved; atime in the props ZAP. If any of them failed, the dataset no longer exists and `zfs create` reports the error.

### 10.5 `inherit` - Inherited values: copied once, or looked up for ever

Category: Properties. What a new tank/home/alice has for properties it was not given: the ZPL create-time ones are copied from tank/home's master node at create; every other property is found at read time by walking up the DSL directories.

```
 1  E009  ioc_keys -> zpl_props  "normalization, utf8only, casesensitivity copied from tank/home's master node"
 2  E029  zpl_props -> zpl_init
 3  E039  ioc_keys -> set_props
 4  E043  set_props -> props_set
 5  E044  props_set -> props_zap  "only the -o properties are stored; the new props ZAP is otherwise empty"
 6  E049  zfs_cmd -> mount_lib
 7  E050  mount_lib -> props_zap  "mountpoint: tank/home has /home, so alice mounts at /home/alice"
 8  E051  mount_lib -> zpl_mount
 9  E052  zpl_mount -> zpl_init
10  E053  zpl_mount -> props_zap  "recordsize, atime and the others are found on tank/home or tank, or are defaults"
```
Ends: `zfs get` shows inherited properties with the ancestor as their source. A later `zfs set atime=off tank/home` changes nothing in alice's ZAP but reaches the mounted alice through dsl_prop_changed_notify(); a later change of normalization on tank/home is impossible, and alice keeps her copy.

### 10.6 `quota_resv` - Quota and reservation checks at create

Category: Space. `-o quota=`, `-o reservation=`, `-o refquota=` or `-o refreservation=` at create (refreservation also the automatic one of a thick volume). Each is its own sync task after the dataset exists, checked against what the parent can still provide.

Alternatives:
- `which`: `resv` quota and reservation (DSL directory, includes descendants and snapshots); `refresv` refquota and refreservation (head dataset only)
- `fits`: `yes` The parent has the space; `no` ENOSPC: the new dataset is destroyed

```
 1  E039  ioc_keys -> set_props
 2  E041  set_props -> quota  [which: resv]
 3  E045  quota -> dir_space  [which: resv]
 4  E046  quota -> props_zap  [which: resv]  [fits: yes]
 5  E042  set_props -> refquota  [which: refresv]
 6  E047  refquota -> dir_space  [which: refresv]
 7  E048  refquota -> props_zap  [which: refresv]  [fits: yes]
 8  E040  set_props -> ioc_keys  [fits: no]
```
Ends: with the space available, the reservation is charged to the parent (reservation) or to the dataset's own usedbyrefreservation and its ancestors (refreservation), and siblings see that much less available space. Without it, `zfs create` fails with "out of space" and the dataset is gone again (its destroy: `zfs-snapshot-lifecycle:destroy_filesystem`).

### 10.7 `txg_write` - The sync task and the txg that writes the new dataset

Category: Sync. The create as the txg sees it: the task joins the open txg, runs in sync pass 1 after the MOS has been written, and dirties the MOS and the new dataset, which pass 2 writes.

```
 1  E013  objset_create -> sync_task
 2  E014  sync_task -> dmu_tx
 3  E015  sync_task -> txg_sync
 4  E016  txg_sync -> spa_sync
 5  E017  spa_sync -> dsl_pool_sync  "pass 1"
 6  E018  dsl_pool_sync -> create_sync
 7  E019  create_sync -> dsl_tree
 8  E020  create_sync -> ds_create
 9  E021  ds_create -> dir_create
10  E022  dir_create -> dsl_tree
11  E023  ds_create -> dsl_tree
12  E025  create_sync -> objset_init
13  E026  objset_init -> dnode
14  E027  objset_init -> dsl_pool_sync
15  E033  dsl_pool_sync -> dmu_objset_sync  "pass 2: the new dataset is now on dp_dirty_datasets"
16  E034  dmu_objset_sync -> dsl_tree
17  E035  dsl_pool_sync -> dir_space
```
Ends: the new DSL objects and object set are on disk once the uberblock of this txg is written (`zfs-io-flow:txg_sync`); txg_wait_synced() returns and `zfs create` continues with the properties.

### 10.8 `mount` - Mount after create

Category: After create. `zfs create` mounts a new file system with canmount=on itself (unless `-u`); `zfs mount` takes the same route.

Alternatives:
- `canmount`: `on` canmount=on and a mountpoint path: mounted; `off` canmount=off or noauto, or mountpoint=none or legacy: not mounted

```
 1  E063  admin -> zfs_cmd
 2  E049  zfs_cmd -> mount_lib
 3  E050  mount_lib -> props_zap
 4  E051  mount_lib -> zpl_mount  [canmount: on]
 5  E052  zpl_mount -> zpl_init  [canmount: on]
 6  E053  zpl_mount -> props_zap  [canmount: on]
```
Ends: the file system is mounted at its mountpoint and shared if sharenfs or sharesmb is set; writes go through `zfs-io-flow:write_async`. An encrypted file system needs its key loaded: `zfs-encryption-keys:mount`.

### 10.9 `clone` - Clone from a snapshot (zfs clone)

Category: Create. `zfs clone tank/home@monday tank/test`: a new DSL directory and head dataset whose ds_bp is the snapshot's, so it shares every block and copies nothing; no object set or type init is created.

Alternatives:
- `crypt`: `plain` Unencrypted origin (no steps of its own); `enc` Encrypted origin: the clone shares its DSL Crypto Key

```
 1  E064  admin -> zfs_cmd
 2  E056  zfs_cmd -> libzfs_dscreate
 3  E057  libzfs_dscreate -> lzc
 4  E058  lzc -> ioc_keys
 5  E059  ioc_keys -> objset_create
 6  E013  objset_create -> sync_task
 7  E014  sync_task -> dmu_tx
 8  E015  sync_task -> txg_sync
 9  E016  txg_sync -> spa_sync
10  E017  spa_sync -> dsl_pool_sync
11  E060  dsl_pool_sync -> clone_sync
12  E061  clone_sync -> ds_create
13  E021  ds_create -> dir_create
14  E022  dir_create -> dsl_tree
15  E062  ds_create -> dsl_tree
16  E024  ds_create -> create_crypt  [crypt: enc]
17  E039  ioc_keys -> set_props
18  E049  zfs_cmd -> mount_lib
```
Ends: tank/test references the same blocks as tank/home@monday and uses no space until it diverges; the snapshot cannot be destroyed while the clone exists. How later writes and the clone's destroy are accounted is in the snapshot graph (`zfs-snapshot-lifecycle:destroy_filesystem`).

## 11. Accuracy rules and known simplifications

Rules: every function, line, tunable and property in this spec was checked at the pinned commit. OS-specific pieces use Linux names (`zfs_create_fs` in `module/os/linux`, `zpl_get_tree`, `zfs_domount`, `zvol_os_create_minor`); FreeBSD has its own versions.

Simplifications made on purpose. State these in the page's About overlay so nobody mistakes the diagram for the whole truth:

1. A sync task's check function runs twice, once in the calling thread and once in syncing context; the diagram draws the check where its effect matters, once, in syncing context.
2. Each property set after the create (quota, reservation, refquota, refreservation and the batch of ordinary properties) is its own sync task with its own dmu_tx and txg wait, exactly like the create task; the diagram draws these as direct wires from zfs_set_prop_nvlist() to their check and sync nodes.
3. With `-p`, every missing ancestor goes through the whole create path; the path draws that repetition once.
4. The txg is drawn down to dmu_objset_sync(); the zio pipeline, block allocation and the uberblock write are in the I/O graph.
5. Encryption at create is one branch; the key handling is in the encryption graph. Delegated permissions, zones and user namespaces, dry runs, user and project quotas and the pool history are mentioned in node text only.
6. The DSL directory tree is one node standing for the on-disk objects (MOS object directory, DSL directories and datasets, their ZAPs); the pool's own creation of the root dataset and $ORIGIN is described in it, not drawn.
7. Returns are drawn only where a result or an error changes the outcome (a failed property destroying the dataset).

## 12. Build order

See `../zfs-io-flow-diagram-spec.md` section 12 and `zfs-viewer-suite-spec.md`.

## 13. Acceptance checklist

- Counts: 36 nodes, 64 wires, 9 paths, 157 path steps, 7 groups, 4 wire types, 124 functions in the index, 244 wire references (Appendix C), 24 tunable and property references (Appendix D).
- Activating path `create_fs` with the default alternative (`crypt: plain`) highlights 32 distinct wires and plays 32 steps; `create_vol` highlights 35 and plays 35; `mount` highlights 6 and plays 6.
- Node `dsl_tree` lists 5 incoming and 0 outgoing wires. Node `props_zap` lists 6 incoming and 0 outgoing wires.
- The six I/O nodes (`dmu_tx`, `txg_sync`, `spa_sync`, `dsl_pool_sync`, `dmu_objset_sync`, `dnode`) show "Also in: ZFS I/O Flow" and keep the I/O graph's titles and contexts; `zfs_cmd`, `mount_lib`, `lzc`, `ioc_keys`, `dcp` and `create_crypt` show the encryption page, `sync_task` the snapshot and send/receive pages.
- Searching `refreservation` finds `vol_defaults` and `refquota`; searching `zvol_volmode` finds `zvol_newdev`.
- The About overlay contains the seven mental-model points and the seven simplifications.

## Appendix A. Function index

Functions named in section 8, with file and line at commit `c913da8615`.

```
calculate_volblocksize  cmd/zfs/zfs_main.c:949
check_parents  lib/libzfs/libzfs_dataset.c:3398
create_parents  lib/libzfs/libzfs_dataset.c:3509
default_volblocksize  cmd/zfs/zfs_main.c:994
dmu_object_alloc  module/zfs/dmu_object.c:217
dmu_object_claim  module/zfs/dmu_object.c:256
dmu_objset_create  module/zfs/dmu_objset.c:1332
dmu_objset_create_check  module/zfs/dmu_objset.c:1177
dmu_objset_create_crypt_check  module/zfs/dsl_crypt.c:1924
dmu_objset_create_impl  module/zfs/dmu_objset.c:1159
dmu_objset_create_impl_dnstats  module/zfs/dmu_objset.c:1065
dmu_objset_create_sync  module/zfs/dmu_objset.c:1242
dmu_objset_sync  module/zfs/dmu_objset.c:1632
dmu_objset_write_done  module/zfs/dmu_objset.c:1524
dmu_objset_write_ready  module/zfs/dmu_objset.c:1493
dmu_tx_assign  module/zfs/dmu_tx.c:1239
dmu_tx_commit  module/zfs/dmu_tx.c:1454
dmu_tx_create_dd  module/zfs/dmu_tx.c:58
dnode_allocate  module/zfs/dnode.c:712
dnode_setdirty  module/zfs/dnode.c:1846
do_mount  lib/libzfs/os/linux/libzfs_mount_os.c:319
dsl_crypto_params_create_nvlist  module/zfs/dsl_crypt.c:133
dsl_dataset_apply_deltas  module/zfs/dsl_dataset.c:2330
dsl_dataset_clone  module/zfs/dsl_dataset.c:3561
dsl_dataset_clone_check  module/zfs/dsl_dataset.c:3485
dsl_dataset_clone_sync  module/zfs/dsl_dataset.c:3535
dsl_dataset_create_crypt_sync  module/zfs/dsl_crypt.c:2034
dsl_dataset_create_sync  module/zfs/dsl_dataset.c:1326
dsl_dataset_create_sync_dd  module/zfs/dsl_dataset.c:1188
dsl_dataset_dirty  module/zfs/dsl_dataset.c:1473
dsl_dataset_set_refquota  module/zfs/dsl_dataset.c:4715
dsl_dataset_set_refquota_check  module/zfs/dsl_dataset.c:4646
dsl_dataset_set_refreservation  module/zfs/dsl_dataset.c:4831
dsl_dataset_set_refreservation_check  module/zfs/dsl_dataset.c:4730
dsl_dataset_set_refreservation_sync_impl  module/zfs/dsl_dataset.c:4790
dsl_dataset_sync  module/zfs/dsl_dataset.c:2133
dsl_dataset_sync_done  module/zfs/dsl_dataset.c:2391
dsl_dataset_zero_zil  module/zfs/dsl_dataset.c:1305
dsl_deleg_set_create_perms  module/zfs/dsl_deleg.c:717
dsl_dir_create_sync  module/zfs/dsl_dir.c:943
dsl_dir_diduse_space  module/zfs/dsl_dir.c:1622
dsl_dir_diduse_space_impl  module/zfs/dsl_dir.c:1567
dsl_dir_hold  module/zfs/dsl_dir.c:464
dsl_dir_hold_obj  module/zfs/dsl_dir.c:165
dsl_dir_is_clone  module/zfs/dsl_dir.c:985
dsl_dir_set_quota  module/zfs/dsl_dir.c:1794
dsl_dir_set_quota_check  module/zfs/dsl_dir.c:1719
dsl_dir_set_quota_sync  module/zfs/dsl_dir.c:1764
dsl_dir_set_reservation  module/zfs/dsl_dir.c:1916
dsl_dir_set_reservation_check  module/zfs/dsl_dir.c:1808
dsl_dir_set_reservation_sync_impl  module/zfs/dsl_dir.c:1866
dsl_dir_space_available  module/zfs/dsl_dir.c:1196
dsl_fs_ss_count_adjust  module/zfs/dsl_dir.c:892
dsl_fs_ss_limit_check  module/zfs/dsl_dir.c:803
dsl_pool_create  module/zfs/dsl_pool.c:475
dsl_pool_create_origin  module/zfs/dsl_pool.c:1263
dsl_pool_sync  module/zfs/dsl_pool.c:700
dsl_pool_sync_mos  module/zfs/dsl_pool.c:579
dsl_prop_changed_notify  module/zfs/dsl_prop.c:595
dsl_prop_get_dd  module/zfs/dsl_prop.c:77
dsl_prop_get_ds  module/zfs/dsl_prop.c:182
dsl_prop_get_integer  module/zfs/dsl_prop.c:362
dsl_prop_register  module/zfs/dsl_prop.c:301
dsl_prop_set_sync_impl  module/zfs/dsl_prop.c:713
dsl_props_set  module/zfs/dsl_prop.c:1027
dsl_props_set_check  module/zfs/dsl_prop.c:934
dsl_props_set_sync  module/zfs/dsl_prop.c:1012
dsl_sync_task  module/zfs/dsl_synctask.c:126
dsl_sync_task_common  module/zfs/dsl_synctask.c:34
dsl_sync_task_sync  module/zfs/dsl_synctask.c:207
lzc_clone  lib/libzfs_core/libzfs_core.c:321
lzc_create  lib/libzfs_core/libzfs_core.c:296
lzc_ioctl  lib/libzfs_core/libzfs_core.c:212
makeprops_parents  cmd/zfs/zfs_main.c:743
parseprop  cmd/zfs/zfs_main.c:623
spa_sync  module/zfs/spa.c:11405
spa_sync_iterate_to_convergence  module/zfs/spa.c:11192
txg_sync_thread  module/zfs/txg.c:510
txg_wait_synced  module/zfs/txg.c:764
volsize_from_vdevs  lib/libzfs/libzfs_dataset.c:5428
zap_create_claim  module/zfs/zap.c:148
zfs_check_settable  module/zfs/zfs_ioctl.c:5289
zfs_clone  lib/libzfs/libzfs_dataset.c:3970
zfs_create  lib/libzfs/libzfs_dataset.c:3631
zfs_create_ancestors_props  lib/libzfs/libzfs_dataset.c:3593
zfs_create_cb  module/zfs/zfs_ioctl.c:3719
zfs_create_fix_auto_resv  lib/libzfs/libzfs_dataset.c:1530
zfs_create_fs  module/os/linux/zfs/zfs_znode_os.c:1970
zfs_dataset_exists  lib/libzfs/libzfs_dataset.c:3483
zfs_do_clone  cmd/zfs/zfs_main.c:827
zfs_do_create  cmd/zfs/zfs_main.c:1087
zfs_domount  module/os/linux/zfs/zfs_vfsops.c:1428
zfs_fill_zplprops  module/zfs/zfs_ioctl.c:3902
zfs_fill_zplprops_impl  module/zfs/zfs_ioctl.c:3749
zfs_get_zplprop  module/zfs/zfs_znode.c:352
zfs_ioc_clone  module/zfs/zfs_ioctl.c:4113
zfs_ioc_create  module/zfs/zfs_ioctl.c:3973
zfs_is_mountable  lib/libzfs/libzfs_mount.c:273
zfs_mount  lib/libzfs/libzfs_mount.c:375
zfs_mount_and_share  cmd/zfs/zfs_main.c:763
zfs_mount_at  lib/libzfs/libzfs_mount.c:390
zfs_prop_set_special  module/zfs/zfs_ioctl.c:2894
zfs_register_callbacks  module/os/linux/zfs/zfs_vfsops.c:264
zfs_secpolicy_create_clone  module/zfs/zfs_ioctl.c:1231
zfs_set_prop_nvlist  module/zfs/zfs_ioctl.c:3129
zfs_share  lib/libzfs/libzfs_mount.c:736
zfs_valid_proplist  lib/libzfs/libzfs_dataset.c:836
zfs_zpl_version_map  module/zcommon/zfs_comutil.c:152
zfsdev_ioctl_common  module/zfs/zfs_ioctl.c:8595
zfsvfs_create  module/os/linux/zfs/zfs_vfsops.c:642
zfsvfs_init  module/os/linux/zfs/zfs_vfsops.c:438
zfsvfs_setup  module/os/linux/zfs/zfs_vfsops.c:716
zpl_get_tree  module/os/linux/zfs/zpl_super.c:839
zprop_parse_value  lib/libzfs/libzfs_util.c:1819
zvol_alloc  module/os/linux/zfs/zvol_os.c:1387
zvol_auto_resv  lib/libzfs/libzfs_dataset.c:1420
zvol_check_volblocksize  module/zfs/zvol.c:481
zvol_check_volsize  module/zfs/zvol.c:282
zvol_create_cb  module/zfs/zvol.c:217
zvol_create_minors  module/zfs/zvol.c:2279
zvol_create_minors_impl  module/zfs/zvol.c:1662
zvol_os_create_minor  module/os/linux/zfs/zvol_os.c:1668
zvol_task_cb  module/zfs/zvol.c:2106
zvol_volsize_to_reservation  lib/libzfs/libzfs_dataset.c:5531
```

## Appendix C. Wire source references

References for the 62 wires, at commit `c913da8615`. Each line is `<wire>  <file>:<line>  <symbol>`, and the symbol appears verbatim on that source line. A wire's references are listed in the order of the calls in its label.

```
E001  cmd/zfs/zfs_main.c:1156  parseprop
E001  cmd/zfs/zfs_main.c:1348  zfs_create
E002  cmd/zfs/zfs_main.c:1204  dryrun
E002  cmd/zfs/zfs_main.c:1219  zfs_valid_proplist
E003  cmd/zfs/zfs_main.c:1228  default_volblocksize
E003  cmd/zfs/zfs_main.c:1000  ZPOOL_CONFIG_MAX_ALLOC
E003  cmd/zfs/zfs_main.c:1026  tgt_volblocksize
E003  cmd/zfs/zfs_main.c:1246  P2ROUNDUP_TYPED
E004  cmd/zfs/zfs_main.c:1237  nvlist_add_string
E004  cmd/zfs/zfs_main.c:1264  ZFS_PROP_REFRESERVATION
E004  cmd/zfs/zfs_main.c:1275  nvlist_exists
E004  cmd/zfs/zfs_main.c:1268  zvol_volsize_to_reservation
E004  lib/libzfs/libzfs_dataset.c:5554  volsize_from_vdevs
E004  lib/libzfs/libzfs_dataset.c:5571  DN_MAX_INDBLKSHIFT
E004  cmd/zfs/zfs_main.c:1348  zfs_create
E005  lib/libzfs/libzfs_dataset.c:3649  zfs_validate_name
E005  lib/libzfs/libzfs_dataset.c:3652  dataset_nestcheck
E005  lib/libzfs/libzfs_dataset.c:3659  check_parents
E005  lib/libzfs/libzfs_dataset.c:3423  ZFS_IOC_OBJSET_STATS
E005  lib/libzfs/libzfs_dataset.c:3692  zfs_valid_proplist
E006  lib/libzfs/libzfs_dataset.c:1016  zprop_parse_value
E006  lib/libzfs/libzfs_dataset.c:1007  zfs_prop_setonce
E006  lib/libzfs/libzfs_dataset.c:1049  ZPOOL_PROP_MAXBLOCKSIZE
E006  lib/libzfs/libzfs_dataset.c:1389  ZFS_PROP_UTF8ONLY
E006  lib/libzfs/libzfs_dataset.c:3698  zfs_create_fix_auto_resv
E006  lib/libzfs/libzfs_dataset.c:3741  multiple
E007  lib/libzfs/libzfs_dataset.c:3748  zfs_crypto_create
E007  lib/libzfs/libzfs_dataset.c:3755  lzc_create
E008  lib/libzfs_core/libzfs_core.c:314  ZFS_IOC_CREATE
E008  module/zfs/zfs_ioctl.c:8697  zfs_check_input_nvpairs
E008  module/zfs/zfs_ioctl.c:8704  zvec_secpolicy
E008  module/zfs/zfs_ioctl.c:1269  ZFS_DELEG_PERM_CREATE
E008  module/zfs/zfs_ioctl.c:1273  ZFS_DELEG_PERM_MOUNT
E008  module/zfs/zfs_ioctl.c:8752  zvec_func
E009  module/zfs/zfs_ioctl.c:4044  zfs_fill_zplprops
E009  module/zfs/zfs_ioctl.c:3928  dmu_objset_hold
E009  module/zfs/zfs_ioctl.c:3775  nvlist_remove_all
E009  module/zfs/zfs_ioctl.c:3832  zfs_get_zplprop
E009  module/zfs/zfs_ioctl.c:3765  ZFS_ERR_WRONG_PARENT
E010  module/zfs/zfs_ioctl.c:4028  zvol_check_volblocksize
E010  module/zfs/zvol.c:491  SPA_FEATURE_LARGE_BLOCKS
E010  module/zfs/zvol.c:500  zfs_max_recordsize
E010  module/zfs/zfs_ioctl.c:4030  zvol_check_volsize
E011  module/zfs/zfs_ioctl.c:4052  dsl_crypto_params_create_nvlist
E011  module/zfs/dsl_crypt.c:224  ZFS_PROP_ENCRYPTION
E012  module/zfs/zfs_ioctl.c:3990  zfs_create_cb
E012  module/zfs/zfs_ioctl.c:3994  zvol_create_cb
E012  module/zfs/zfs_ioctl.c:4059  dmu_objset_create
E012  module/zfs/zfs_ioctl.c:4060  DS_FLAG_CI_DATASET
E013  module/zfs/dmu_objset.c:1358  dsl_sync_task
E013  module/zfs/dmu_objset.c:1359  dmu_objset_create_check
E013  module/zfs/dsl_dataset.c:3573  dsl_dataset_clone_check
E013  module/zfs/dsl_synctask.c:64  dst_checkfunc
E014  module/zfs/dsl_synctask.c:50  dmu_tx_create_dd
E014  module/zfs/dsl_synctask.c:51  dmu_tx_assign
E014  module/zfs/dsl_synctask.c:75  txg_list_add_tail
E014  module/zfs/dsl_synctask.c:77  dmu_tx_commit
E015  module/zfs/dsl_synctask.c:91  txg_wait_synced
E016  module/zfs/txg.c:602  spa_sync
E017  module/zfs/spa.c:11502  spa_sync_iterate_to_convergence
E017  module/zfs/spa.c:11208  dsl_pool_sync
E017  module/zfs/spa.c:11289  dmu_objset_is_dirty
E018  module/zfs/dsl_pool.c:841  dsl_pool_sync_mos
E018  module/zfs/dsl_pool.c:874  spa_sync_pass
E018  module/zfs/dsl_pool.c:876  dsl_sync_task_sync
E018  module/zfs/dsl_synctask.c:232  dst_space
E018  module/zfs/dsl_synctask.c:244  dst_checkfunc
E018  module/zfs/dsl_synctask.c:246  dst_syncfunc
E019  module/zfs/dmu_objset.c:1196  dsl_dir_hold
E019  module/zfs/dsl_dir.c:503  zap_lookup
E019  module/zfs/dsl_dir.c:534  ENOENT
E019  module/zfs/dmu_objset.c:1201  EEXIST
E019  module/zfs/dmu_objset.c:1210  dsl_fs_ss_limit_check
E019  module/zfs/dsl_dir.c:876  EDQUOT
E019  module/zfs/dmu_objset.c:1233  ZFS_ERR_WRONG_PARENT
E020  module/zfs/dmu_objset.c:1255  dsl_dir_hold
E020  module/zfs/dmu_objset.c:1257  dsl_dataset_create_sync
E021  module/zfs/dsl_dataset.c:1345  dsl_dir_create_sync
E022  module/zfs/dsl_dir.c:951  dmu_object_alloc
E022  module/zfs/dsl_dir.c:954  dd_child_dir_zapobj
E022  module/zfs/dsl_dir.c:970  dsl_fs_ss_count_adjust
E022  module/zfs/dsl_dir.c:972  dd_props_zapobj
E022  module/zfs/dsl_dir.c:974  dd_child_dir_zapobj
E023  module/zfs/dsl_dataset.c:1348  dsl_dataset_create_sync_dd
E023  module/zfs/dsl_dataset.c:1198  dp_origin_snap
E023  module/zfs/dsl_dataset.c:1205  dmu_object_alloc
E023  module/zfs/dsl_dataset.c:1214  ds_guid
E023  module/zfs/dsl_dataset.c:1216  ds_snapnames_zapobj
E023  module/zfs/dsl_dataset.c:1227  ds_prev_snap_obj
E023  module/zfs/dsl_dataset.c:1237  ds_bp
E023  module/zfs/dsl_dataset.c:1299  dd_head_dataset_obj
E023  module/zfs/dsl_dataset.c:1351  dsl_deleg_set_create_perms
E024  module/zfs/dsl_dataset.c:1291  dsl_dataset_create_crypt_sync
E024  module/zfs/dsl_crypt.c:2042  dsl_dir_is_clone
E024  module/zfs/dsl_crypt.c:2079  ZIO_CRYPT_OFF
E025  module/zfs/dmu_objset.c:1261  DS_HOLD_FLAG_DECRYPT
E025  module/zfs/dmu_objset.c:1264  dmu_objset_create_impl
E026  module/zfs/dmu_objset.c:1085  dnode_allocate
E026  module/zfs/dmu_objset.c:1117  levels
E026  module/zfs/dmu_objset.c:1127  os_type
E026  module/zfs/dmu_objset.c:1134  OBJSET_FLAG_USERACCOUNTING_COMPLETE
E027  module/zfs/dmu_objset.c:1152  dsl_dataset_dirty
E027  module/zfs/dsl_dataset.c:1489  dp_dirty_datasets
E028  module/zfs/dmu_objset.c:1268  doca_userfunc
E028  module/zfs/zfs_ioctl.c:3723  zfs_create_fs
E029  module/os/linux/zfs/zfs_znode_os.c:2015  zap_update
E029  module/os/linux/zfs/zfs_znode_os.c:2024  ZPL_VERSION_STR
E030  module/os/linux/zfs/zfs_znode_os.c:1994  zap_create_claim
E030  module/os/linux/zfs/zfs_znode_os.c:2032  DMU_OT_SA_MASTER_NODE
E030  module/os/linux/zfs/zfs_znode_os.c:2042  DMU_OT_UNLINKED_SET
E030  module/os/linux/zfs/zfs_znode_os.c:2052  S_IFDIR
E030  module/os/linux/zfs/zfs_znode_os.c:2105  zfs_mknode
E030  module/os/linux/zfs/zfs_znode_os.c:2107  ZFS_ROOT_OBJ
E030  module/zfs/dnode.c:797  dnode_setdirty
E031  module/zfs/dmu_objset.c:1268  doca_userfunc
E031  module/zfs/zfs_ioctl.c:3994  zvol_create_cb
E032  module/zfs/zvol.c:234  ZFS_PROP_VOLSIZE
E032  module/zfs/zvol.c:238  dmu_object_claim
E032  module/zfs/zvol.c:242  zap_create_claim
E032  module/zfs/zvol.c:246  zap_update
E033  module/zfs/dsl_pool.c:744  dsl_dataset_sync
E033  module/zfs/dsl_dataset.c:2161  dmu_objset_sync
E033  module/zfs/dmu_objset.c:1681  arc_write
E033  module/zfs/dsl_pool.c:841  dsl_pool_sync_mos
E034  module/zfs/dmu_objset.c:1518  os_rootbp
E034  module/zfs/dsl_pool.c:589  spa_set_rootblkptr
E035  module/zfs/dmu_objset.c:1538  dsl_dataset_block_born
E035  module/zfs/dsl_pool.c:816  dsl_dataset_sync_done
E035  module/zfs/dsl_dataset.c:2395  dsl_dataset_apply_deltas
E035  module/zfs/dsl_dataset.c:2380  dsl_dir_diduse_transfer_space
E036  module/zfs/dmu_objset.c:1363  zvol_create_minors
E036  module/zfs/zvol.c:2291  spa_zvol_taskq
E036  module/zfs/zvol.c:2293  taskq_wait_id
E037  module/zfs/zvol.c:1557  snapdev
E037  module/os/linux/zfs/zvol_os.c:1395  volmode
E037  module/os/linux/zfs/zvol_os.c:1400  zvol_volmode
E037  module/os/linux/zfs/zvol_os.c:1402  ZFS_VOLMODE_NONE
E037  module/os/linux/zfs/zvol_os.c:1733  volthreading
E038  module/zfs/zvol.c:1722  zvol_os_create_minor
E038  module/os/linux/zfs/zvol_os.c:1707  dmu_objset_own
E038  module/os/linux/zfs/zvol_os.c:1715  ZVOL_ZAP_OBJ
E038  module/os/linux/zfs/zvol_os.c:1719  zvol_alloc
E038  module/os/linux/zfs/zvol_os.c:1758  zil_open
E038  module/os/linux/zfs/zvol_os.c:1777  dmu_prefetch
E038  module/os/linux/zfs/zvol_os.c:1799  zvol_os_add_disk
E038  udev/rules.d/60-zvol.rules.in:11  zvol_id
E039  module/zfs/zfs_ioctl.c:4069  zfs_set_prop_nvlist
E039  module/zfs/zfs_ioctl.c:4134  zfs_set_prop_nvlist
E040  module/zfs/zfs_ioctl.c:4081  dsl_destroy_head
E040  module/zfs/zfs_ioctl.c:4137  dsl_destroy_head
E041  module/zfs/zfs_ioctl.c:3207  zfs_check_settable
E041  module/zfs/zfs_ioctl.c:3213  zfs_prop_set_special
E041  module/zfs/zfs_ioctl.c:2924  dsl_dir_set_quota
E041  module/zfs/zfs_ioctl.c:2955  dsl_dir_set_reservation
E042  module/zfs/zfs_ioctl.c:2927  dsl_dataset_set_refquota
E042  module/zfs/zfs_ioctl.c:2958  dsl_dataset_set_refreservation
E043  module/zfs/zfs_ioctl.c:3227  retrynvl
E043  module/zfs/zfs_ioctl.c:3252  dsl_props_set
E044  module/zfs/dsl_prop.c:1043  dsl_sync_task
E044  module/zfs/dsl_prop.c:1019  dsl_props_set_sync_impl
E044  module/zfs/dsl_prop.c:742  dd_props_zapobj
E044  module/zfs/dsl_prop.c:778  inheritstr
E044  module/zfs/dsl_prop.c:780  zap_update
E044  module/zfs/dsl_prop.c:868  dsl_prop_changed_notify
E045  module/zfs/dsl_dir.c:1755  dd_used_bytes
E045  module/zfs/dsl_dir.c:1756  ENOSPC
E045  module/zfs/dsl_dir.c:1844  dsl_dir_space_available
E045  module/zfs/dsl_dir.c:1858  ENOSPC
E045  module/zfs/dsl_dir.c:1880  DD_USED_CHILD_RSRV
E046  module/zfs/dsl_dir.c:1774  dsl_prop_set_sync_impl
E046  module/zfs/dsl_dir.c:1788  dd_quota
E046  module/zfs/dsl_dir.c:1911  dsl_dir_set_reservation_sync_impl
E047  module/zfs/dsl_dataset.c:4778  dsl_dir_space_available
E047  module/zfs/dsl_dataset.c:4781  ENOSPC
E047  module/zfs/dsl_dataset.c:4810  ds_reserved
E047  module/zfs/dsl_dataset.c:4813  DD_USED_REFRSRV
E047  module/zfs/dsl_dir.c:1615  dsl_dir_diduse_transfer_space_impl
E048  module/zfs/dsl_dataset.c:4679  ds_referenced_bytes
E048  module/zfs/dsl_dataset.c:4699  dsl_prop_set_sync_impl
E048  module/zfs/dsl_dataset.c:4709  ds_quota
E048  module/zfs/dsl_dataset.c:4797  dsl_prop_set_sync_impl
E049  cmd/zfs/zfs_main.c:1363  zfs_mount_and_share
E049  cmd/zfs/zfs_main.c:776  ZFS_TYPE_VOLUME
E049  cmd/zfs/zfs_main.c:790  ZFS_CANMOUNT_ON
E049  cmd/zfs/zfs_main.c:796  zfs_mount
E049  cmd/zfs/zfs_main.c:800  zfs_share
E050  lib/libzfs/libzfs_mount.c:283  ZFS_PROP_MOUNTPOINT
E050  lib/libzfs/libzfs_dataset.c:326  ZFS_IOC_OBJSET_STATS
E050  module/zfs/zfs_ioctl.c:2506  dsl_prop_get_all
E050  lib/libzfs/libzfs_dataset.c:2616  relpath
E050  lib/libzfs/libzfs_mount.c:287  ZFS_MOUNTPOINT_LEGACY
E050  lib/libzfs/libzfs_mount.c:290  ZFS_CANMOUNT_OFF
E051  lib/libzfs/libzfs_mount.c:383  zfs_mount_at
E051  lib/libzfs/libzfs_mount.c:498  mkdirp
E051  lib/libzfs/libzfs_mount.c:513  ZFS_PROP_OVERLAY
E051  lib/libzfs/libzfs_mount.c:527  dir_is_empty
E051  lib/libzfs/libzfs_mount.c:535  do_mount
E051  lib/libzfs/os/linux/libzfs_mount_os.c:335  MNTTYPE_ZFS
E051  module/os/linux/zfs/zpl_super.c:912  zfs_domount
E052  module/os/linux/zfs/zfs_vfsops.c:1456  zfsvfs_create
E052  module/os/linux/zfs/zfs_vfsops.c:651  dmu_objset_own
E052  module/os/linux/zfs/zfs_vfsops.c:696  zfsvfs_init
E052  module/os/linux/zfs/zfs_vfsops.c:447  ZFS_PROP_VERSION
E052  module/os/linux/zfs/zfs_vfsops.c:531  ZFS_ROOT_OBJ
E053  module/os/linux/zfs/zfs_vfsops.c:1460  dsl_prop_get_integer
E053  module/os/linux/zfs/zfs_vfsops.c:1517  zfsvfs_setup
E053  module/os/linux/zfs/zfs_vfsops.c:721  zfs_register_callbacks
E053  module/os/linux/zfs/zfs_vfsops.c:296  dsl_prop_register
E053  module/os/linux/zfs/zfs_vfsops.c:303  blksz_changed_cb
E053  module/zfs/dsl_prop.c:313  dsl_prop_get_int_ds
E053  module/zfs/dsl_prop.c:331  cbr_func
E054  cmd/zfs/zfs_main.c:1289  makeprops_parents
E054  cmd/zfs/zfs_main.c:752  ZFS_PROP_CANMOUNT
E054  cmd/zfs/zfs_main.c:1296  zfs_dataset_exists
E054  cmd/zfs/zfs_main.c:1306  zfs_create_ancestors_props
E055  lib/libzfs/libzfs_dataset.c:3614  check_parents
E055  lib/libzfs/libzfs_dataset.c:3618  create_parents
E055  lib/libzfs/libzfs_dataset.c:3546  zfs_create
E055  lib/libzfs/libzfs_dataset.c:3557  zfs_mount
E055  lib/libzfs/libzfs_dataset.c:3562  zfs_share
E056  cmd/zfs/zfs_main.c:886  ZFS_TYPE_SNAPSHOT
E056  cmd/zfs/zfs_main.c:904  zfs_create_ancestors_props
E056  cmd/zfs/zfs_main.c:910  zfs_clone
E057  lib/libzfs/libzfs_dataset.c:3988  check_parents
E057  lib/libzfs/libzfs_dataset.c:4000  zfs_valid_proplist
E057  lib/libzfs/libzfs_dataset.c:4009  zfs_crypto_clone_check
E057  lib/libzfs/libzfs_dataset.c:4014  lzc_clone
E058  lib/libzfs_core/libzfs_core.c:330  ZFS_IOC_CLONE
E058  module/zfs/zfs_ioctl.c:8037  zfs_secpolicy_create_clone
E058  module/zfs/zfs_ioctl.c:1265  ZFS_DELEG_PERM_CLONE
E059  module/zfs/zfs_ioctl.c:4128  dsl_dataset_clone
E060  module/zfs/dsl_synctask.c:244  dst_checkfunc
E060  module/zfs/dsl_dataset.c:3508  dsl_fs_ss_limit_check
E060  module/zfs/dsl_dataset.c:3522  ds_is_snapshot
E060  module/zfs/dsl_synctask.c:246  dst_syncfunc
E061  module/zfs/dsl_dataset.c:3548  dsl_dataset_create_sync
E062  module/zfs/dsl_dataset.c:1237  ds_bp
E062  module/zfs/dsl_dataset.c:1255  ds_num_children
E062  module/zfs/dsl_dataset.c:1271  ds_next_clones_obj
E062  module/zfs/dsl_dataset.c:1276  dd_origin_obj
E062  module/zfs/dsl_dataset.c:1362  DD_FIELD_LIVELIST
E062  module/zfs/dsl_dataset.c:1392  dsl_dataset_zero_zil
E063  cmd/zfs/zfs_main.c:194  zfs_do_create
E064  cmd/zfs/zfs_main.c:199  zfs_do_clone
```

## Appendix D. Tunable and property source references

Where each tunable and dataset property named in section 8 is declared, at commit `c913da8615`. A tunable's symbol is the name part as written in its `ZFS_MODULE_PARAM` line; a property's symbol is its quoted name in the `zprop_register_*()` call in `module/zcommon/zfs_prop.c`.

```
zfs_max_recordsize  module/zfs/dsl_dataset.c:5329  max_recordsize
zvol_inhibit_dev  module/zfs/zvol.c:2446  inhibit_dev
zvol_prefetch_bytes  module/zfs/zvol.c:2448  prefetch_bytes
zvol_volmode  module/zfs/zvol.c:2450  mode
canmount  module/zcommon/zfs_prop.c:535  "canmount"
casesensitivity  module/zcommon/zfs_prop.c:556  "casesensitivity"
encryption  module/zcommon/zfs_prop.c:565  "encryption"
filesystem_limit  module/zcommon/zfs_prop.c:704  "filesystem_limit"
mountpoint  module/zcommon/zfs_prop.c:582  "mountpoint"
normalization  module/zcommon/zfs_prop.c:552  "normalization"
origin  module/zcommon/zfs_prop.c:577  "origin"
overlay  module/zcommon/zfs_prop.c:527  "overlay"
quota  module/zcommon/zfs_prop.c:690  "quota"
recordsize  module/zcommon/zfs_prop.c:734  "recordsize"
refquota  module/zcommon/zfs_prop.c:698  "refquota"
refreservation  module/zcommon/zfs_prop.c:701  "refreservation"
reservation  module/zcommon/zfs_prop.c:692  "reservation"
sharenfs  module/zcommon/zfs_prop.c:585  "sharenfs"
snapdev  module/zcommon/zfs_prop.c:432  "snapdev"
utf8only  module/zcommon/zfs_prop.c:572  "utf8only"
version  module/zcommon/zfs_prop.c:532  "version"
volblocksize  module/zcommon/zfs_prop.c:640  "volblocksize"
volmode  module/zcommon/zfs_prop.c:477  "volmode"
volsize  module/zcommon/zfs_prop.c:695  "volsize"
```
