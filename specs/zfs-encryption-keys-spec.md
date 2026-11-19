# ZFS encryption keys (build spec)

This spec describes a diagram of OpenZFS native encryption from the key's point of view: which key actually encrypts a block, how a passphrase becomes a wrapping key, how the wrapping key protects each dataset's master key in its DSL Crypto Key object, what `zfs load-key`, `zfs unload-key` and `zfs change-key` do in the kernel, why a passphrase change rewrites no data, what an encryption root is, how blocks are encrypted, decrypted and authenticated in the zio pipeline and the ARC, and what a raw send carries.

Source of truth: `https://github.com/openzfs/zfs` at commit `c913da86156eba3243cc1ef515e98d69887654a7` (master, 2026-11-13, version 2.4.99). Every function name, file path and tunable in this document was checked against that commit.

## 0. Instructions to the building agent

Render this spec with the viewer in `../viewer`, as extended by `zfs-viewer-suite-spec.md`. Treat sections 6 to 10 and the appendices as data. Do not add, remove or re-route nodes and wires unless you have verified the change in the source at the pinned commit.

## 1. Goal

One page that lets an administrator answer "which key actually encrypts my data, what does a passphrase change touch, what is an encryption root, what does `zfs load-key` do, and what does a raw send carry?" by following wires between boxes.

### Mental model the diagram has to convey

1. There are two layers of keys. Blocks are encrypted with keys derived from a dataset's master key, which is random, never changes and never leaves the kernel unwrapped. The user's key (passphrase, raw or hex) only becomes the 32-byte wrapping key, which encrypts the master key inside the dataset's DSL Crypto Key object in the pool's meta-object set (MOS).
2. Because only the wrapped copy of the master key depends on the user's key, `zfs change-key` rewrites a few small key objects in one txg and no data block. The new wrapping key replaces the old one; the master keys stay the same.
3. An encryption root is the dataset whose wrapping key is used. A child created without its own key still gets a master key of its own, but wraps it with the root's wrapping key; its key object records the root, and the keystore finds the wrapping key through that record. Snapshots share their dataset's key object and clones share their origin's. `load-key` and `unload-key` act only on encryption roots; `change-key` can turn any dataset that is not a clone into one.
4. `zfs load-key` only puts the wrapping key in memory, after proving it by unwrapping the root's master key. A master key is unwrapped when a dataset is opened for decryption (mount, zvol open), and the key mapping created then is what every encrypting or decrypting I/O looks up. `unload-key` fails with EBUSY while any dataset under the root is still open.
5. Block encryption happens in the ENCRYPT stage, after compression: AES-GCM or AES-CCM with a random 96-bit IV and a data key derived with HKDF from the master key and a 64-bit salt. A salt (and its key) is shared by many blocks and rotated after a limit. Salt, IV and MAC are stored in the block pointer.
6. Not everything is encrypted. The MOS (pool metadata, including the key objects) is not encrypted at all. Inside an encrypted dataset, indirect blocks, the objset block, the core of each dnode and some object types stay readable but are authenticated (HMAC, or a hash of the children's MACs), so the pool can be scrubbed and the dataset raw-sent without keys.
7. A raw send (`zfs send -w`) ships the blocks as stored plus the master key still wrapped; the receiver stores both unchanged and can only read the data after `zfs load-key` with the sender's key.

### Scope

In scope: dataset creation with encryption, key material and wrapping key derivation in libzfs, the key ioctls, the keystore (wrapping keys, DSL Crypto Keys, key mappings), the DSL Crypto Key object on disk, `load-key`, `unload-key`, `change-key` and `change-key -i`, mount and unmount as they affect keys, block encryption, decryption and authentication in the zio pipeline and the ARC, and the key data of a raw send and receive.

Out of scope: the send stream format and receive mechanics (send/receive graph, page `zfs-send-receive`), the zio pipeline and vdev I/O around the crypto stages (I/O flow graph), encrypted dedup and ZIL internals beyond the node text, `zfs promote` and `zfs rename` crypto checks, the forced change-key commands (`DCP_CMD_FORCE_NEW_KEY`, `DCP_CMD_FORCE_INHERIT`), L2ARC handling of encrypted buffers, and the crypto provider back ends (ICP, Linux kernel crypto, QAT).

## 2. Deliverable

The page is built by `../viewer/build_graph.py --spec specs/zfs-encryption-keys-spec.md --repo zfs` and validated by `../viewer/validate_graph.py` with the same spec. Its page name is `zfs-encryption-keys.html`; it belongs to the suite described in `zfs-viewer-suite-spec.md`.

## 6. Wire types and contexts

### 6.1 Wire types

The colours are the suite-wide colours of `README.md` section 6. `key` is reserved for this graph.

| type id | colour | name | what travels on the wire |
|---|---|---|---|
| `key` | `#20C997` | Key material | User key material, the 32-byte wrapping key, wrapped or unwrapped master and HMAC keys, salts and IVs used to derive or apply them. |
| `abd` | `#FF6B6B` | Physical payload | abd_t: block bytes as stored (ciphertext, or plaintext with a MAC) or their decrypted form. |
| `arc` | `#B197FC` | ARC buffer | arc_buf_t / arc_buf_hdr_t: cached block handed to a consumer. |
| `zio` | `#4DABF7` | I/O request | zio_t moving through the pipeline. |
| `bp` | `#F783AC` | Block pointer | blkptr_t fields: here the salt, IV and MAC stored in it. |
| `tx` | `#FFD43B` | Transaction | A sync task queued for a txg. |
| `ctl` | `#868E96` | Control | Calls that carry no key or payload: lookups, checks, holds and releases, errors. Draw dashed. |

### 6.2 Execution contexts

| ctx id | meaning |
|---|---|
| `user` | Userspace (`zfs` command, libzfs, libzfs_core) |
| `syscall` | Kernel, in the thread of the calling process (an ioctl on /dev/zfs, mount(2) or umount(2)) or a helper thread it starts, outside syncing context and outside any dmu_tx |
| `sync` | Syncing context: txg_sync thread, one txg at a time (sync tasks run here) |
| `iss` | zio issue taskq: CPU work such as encryption |
| `int` | zio interrupt taskq: completion processing such as decryption |
| `any` | Runs in whichever context calls it |

## 7. Groups and default layout

Flow runs left to right: the administrator's commands on the left, the kernel keystore and key objects in the middle, the data path and block crypto on the right.

| group id | title | colour | first column | band | sub-columns | nodes | summary |
|---|---|---|---|---|---|---|---|
| `user` | Userspace - zfs, libzfs | `#5C5F66` | 0 | full | 2 | 7 | Commands, key material, wrapping key derivation and the ioctl wrappers. The passphrase never enters the kernel. |
| `kentry` | Kernel entry - ioctl, mount | `#2B8A3E` | 2 | full | 1 | 3 | Key ioctls, crypto parameters, and opening a dataset for decryption. |
| `keystore` | Keystore (in memory) | `#0CA678` | 3 | full | 2 | 6 | The per-pool spa_keystore: loaded wrapping keys, unwrapped master keys, and dataset-to-key mappings. |
| `dsl` | Sync tasks + DSL Crypto Key (on disk) | `#E67700` | 5 | full | 2 | 6 | Creating and rewrapping master keys in syncing context, and the key object they are stored in. |
| `pipe` | Shared - DMU, ARC, zio stages | `#1971C2` | 7 | full | 2 | 7 | The I/O graph's nodes where blocks get encrypted, decrypted and authenticated. |
| `crypt` | Block encryption + authentication | `#AE3EC9` | 9 | top | 2 | 5 | Key lookup, salt and IV, AES-GCM / AES-CCM, HMACs, and the crypto fields of the block pointer. |
| `send` | Raw send + receive | `#C2255C` | 9 | bottom | 2 | 2 | What `zfs send -w` puts in the stream and how a receive stores it. |

Default layout rules:

- Column pitch is 400 px. A group starts at `first column * 400` and is `sub-columns` columns wide. A node's x is `(group first column + node sub-col) * 400`.
- Inside a sub-column, stack nodes top to bottom in the order they appear in the section 8 tables, 28 px apart. Node height follows its socket count.
- Band `full` groups start at the top. Groups `crypt` (band `top`) and `send` (band `bottom`) share columns 9 and 10: place `send` 90 px below the bottom of `crypt`.
- The layout must be deterministic. Do not run a force-directed or randomised layout in the page.
- Check the default at "fit all": group titles must be readable and no node may overlap another.

## 8. Nodes

36 nodes. `sub-col` is the node's column inside its group. `functions` are real symbols at the pinned commit (locations in Appendix A); the first one is the node's headline function. Eight nodes are shared with the I/O flow graph and keep its ids, titles and contexts.

### 8.1 Userspace - zfs, libzfs (`user`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `admin` | Administrator | 0 | `user` | - | - | The person or script typing the command. Every path in this graph that a command starts begins with a wire from this node; the arrows that come back into a command node are its results, errors and refusals. |
| `zfs_cmd` | zfs(8) command | 0 | `user` | `cmd/zfs/zfs_main.c` | `zfs_do_create`, `zfs_do_load_key`, `zfs_do_unload_key`, `load_unload_keys`, `load_key_callback`, `zfs_do_change_key`, `zfs_do_send` | The administrator's entry points: `zfs create`, `zfs load-key` and `zfs unload-key` (`-r` and `-a` act only on encryption roots not already in the wanted state; `-n` only verifies the key; `-L` overrides keylocation), `zfs change-key` (`-l` loads the current key first, `-i` inherits the parent's key, `-o` sets keyformat, keylocation or pbkdf2iters) and `zfs send -w`. |
| `mount_lib` | libzfs mount / unmount | 0 | `user` | `lib/libzfs/libzfs_mount.c` | `zfs_mount_at`, `zfs_unmount`, `share_mount_one`, `unshare_unmount` | `zfs mount -l` sets MS_CRYPT: if the dataset's keystatus is unavailable, the key of its encryption root is loaded before mount(2). Without `-l` such a mount fails with "encryption key not loaded". `zfs unmount -u` also sets MS_CRYPT: after unmounting an encryption root whose key is loaded, it unloads the key. |
| `libzfs_crypto` | libzfs key operations | 0 | `user` | `lib/libzfs/libzfs_crypto.c` | `zfs_crypto_create`, `zfs_crypto_load_key`, `zfs_crypto_unload_key`, `zfs_crypto_rewrap`, `zfs_crypto_get_encryption_root`, `zfs_create` | Policy checks before any ioctl. Create: a dataset given keyformat (keylocation defaults to prompt) becomes a new encryption root; one given neither inherits its encrypted parent's key, even with a different encryption suite. Load and unload work only on an encryption root. change-key refuses clones and needs the current key loaded; `-i` needs an encryption root whose parent is encrypted and has its key loaded. Properties: `encryption`, `encryptionroot`, `keystatus`. |
| `key_material` | Key material (keylocation) | 1 | `user` | `lib/libzfs/libzfs_crypto.c` | `get_key_material`, `get_key_interactive`, `get_key_material_file`, `get_key_material_https`, `validate_key` | Reads the user's key from keylocation: `prompt` (the terminal, or stdin when it is not a terminal), `file://`, or `http(s)://`. At a terminal a new key is asked for twice; raw keys cannot be typed. Checks the format: raw exactly 32 bytes, hex exactly 64 hex digits, a new passphrase 8 to 512 characters. Properties: `keylocation`, `keyformat`. |
| `derive_key` | Wrapping key derivation | 1 | `user` | `lib/libzfs/libzfs_crypto.c` | `derive_key`, `hex_key_to_raw`, `populate_create_encryption_params_nvlists` | Turns key material into the 32-byte wrapping key, in userspace: the kernel never sees a passphrase. raw: used as is. hex: decoded. passphrase: PBKDF2-HMAC-SHA1 with the dataset's 64-bit pbkdf2salt and pbkdf2iters iterations, deliberately slow. Every new passphrase key gets a new random salt; pbkdf2iters defaults to 350000 and the kernel refuses fewer than 100000. Properties: `pbkdf2iters`, `pbkdf2salt`. |
| `lzc` | libzfs_core | 1 | `user` | `lib/libzfs_core/libzfs_core.c` | `lzc_create`, `lzc_load_key`, `lzc_unload_key`, `lzc_change_key`, `lzc_ioctl` | Packs the arguments into nvlists for /dev/zfs. The wrapping key travels as the uint8 array `wkeydata` inside the `hidden_args` nvlist, which is stripped before the command is written to pool history. |

### 8.2 Kernel entry - ioctl, mount (`kentry`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `ioc_keys` | Create and key ioctls | 0 | `syscall` | `module/zfs/zfs_ioctl.c` | `zfs_ioc_create`, `zfs_ioc_load_key`, `zfs_ioc_unload_key`, `zfs_ioc_change_key` | Kernel entry for ZFS_IOC_CREATE, ZFS_IOC_LOAD_KEY, ZFS_IOC_UNLOAD_KEY and ZFS_IOC_CHANGE_KEY. The key commands refuse snapshot names (containing `@` or `%`). |
| `dcp` | dsl_crypto_params | 0 | `syscall` | `module/zfs/dsl_crypt.c` | `dsl_crypto_params_create_nvlist`, `dsl_wrapping_key_create`, `dsl_crypto_params_free` | Builds a dsl_crypto_params_t from the ioctl nvlists: the command, the encryption suite (`on` means aes-256-gcm), keylocation, and a dsl_wrapping_key_t holding the 32-byte key with its keyformat, salt and iteration count. encryption, keyformat, pbkdf2salt and pbkdf2iters are removed from the property list: they live in the DSL Crypto Key, not as ordinary dataset properties. |
| `objset_own` | Dataset opened for decryption | 0 | `syscall` | `module/zfs/dmu_objset.c` | `dmu_objset_own`, `dsl_dataset_hold_obj_flags`, `dsl_dataset_create_key_mapping`, `dsl_dataset_rele_flags`, `dsl_dataset_remove_key_mapping`, `dmu_objset_disown`, `zfsvfs_create`, `zfs_umount` | Mounting a file system (`zfsvfs_create()`) or opening a zvol owns the dataset with decrypt set. DS_HOLD_FLAG_DECRYPT creates a key mapping, which fails with EACCES when the key is not loaded. If the objset block is still unauthenticated, its MACs are checked here. Disowning at unmount removes the mapping. Raw send holds datasets without decrypt and needs no key. |

### 8.3 Keystore (in memory) (`keystore`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `ks_load` | spa_keystore_load_wkey() | 0 | `syscall` | `module/zfs/dsl_crypt.c` | `spa_keystore_load_wkey`, `spa_keystore_load_wkey_impl` | `zfs load-key` in the kernel. The dataset must be its own encryption root (EINVAL otherwise). The offered key is proved by unwrapping this dataset's DSL Crypto Key; its keyformat, salt and iterations are then taken from that key object. With noop (`-n`) it stops there. Otherwise the wrapping key is inserted in the keystore and zvols under the dataset are created. No master key stays in memory. |
| `ks_unload` | spa_keystore_unload_wkey() | 0 | `syscall` | `module/zfs/dsl_crypt.c` | `spa_keystore_unload_wkey`, `spa_keystore_unload_wkey_impl` | `zfs unload-key` in the kernel. Waits for a txg sync so that pending writes drop their key holds, then removes the wrapping key: EACCES if it is not loaded, EBUSY while any DSL Crypto Key still holds it (some dataset under this encryption root is still mounted or open with decryption). The key is zeroed and freed and zvol device nodes under the dataset are removed. |
| `dck_open` | Master key unwrap | 0 | `any` | `module/zfs/dsl_crypt.c` | `dsl_crypto_key_open`, `zio_crypt_key_unwrap` | Reads the DSL Crypto Key object and decrypts the master key and HMAC key with the wrapping key, using the dataset's cipher mode (GCM or CCM) with the key guid, suite and version as authenticated data. A MAC failure means the wrong wrapping key and returns EACCES. On success a fresh random salt is chosen and the current data key is derived from the master key with HKDF-SHA512. |
| `wkey_tree` | Wrapping key tree (sk_wkeys) | 1 | `any` | `module/zfs/dsl_crypt.c` | `spa_keystore_wkey_hold_dd`, `dmu_objset_check_wkey_loaded`, `dsl_dataset_get_keystatus`, `dsl_wrapping_key_free` | Loaded wrapping keys, one per encryption root, keyed by the root's dsl_dir object number. A dataset finds its wrapping key by reading the root's object number from its own DSL Crypto Key; this lookup is all that "inheriting the key" means. Refcounted: every in-memory master key holds its wrapping key. keystatus is `available` exactly when this lookup succeeds. Properties: `keystatus`. |
| `dck_tree` | DSL Crypto Key tree (sk_dsl_keys) | 1 | `any` | `module/zfs/dsl_crypt.c` | `spa_keystore_dsl_key_hold_dd`, `spa_keystore_dsl_key_rele`, `dsl_crypto_key_free` | Unwrapped master keys in memory, one per DSL Crypto Key object and refcounted, so snapshots and clones that share a key object share this entry. A hold that misses the tree unwraps the key from disk with the encryption root's wrapping key. At refcount zero the key is zeroed and freed and its hold on the wrapping key is dropped. |
| `km_tree` | Key mapping tree (sk_key_mappings) | 1 | `any` | `module/zfs/dsl_crypt.c` | `spa_keystore_create_mapping`, `spa_keystore_remove_mapping`, `key_mapping_rele`, `spa_keystore_lookup_key` | Maps a dataset object number to its master key. Created when a dataset is held with decryption, released when it is released or disowned. Every encrypt, decrypt and MAC operation looks its key up here by the block's objset id; no mapping means EACCES. |

### 8.4 Sync tasks + DSL Crypto Key (on disk) (`dsl`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `spa_sync` | spa_sync() | 0 | `sync` | `module/zfs/spa.c` | `spa_sync`, `spa_sync_iterate_to_convergence`, `dsl_sync_task`, `dsl_sync_task_sync` | Shared with the I/O flow graph. Creating an encrypted dataset and changing a key are DSL sync tasks: `dsl_sync_task()` runs the check function in the caller, then the caller waits while `spa_sync()` (through `dsl_pool_sync()`) runs the check again and then the sync function, so the change lands atomically in one txg. |
| `create_crypt` | Encrypted dataset creation | 0 | `sync` | `module/zfs/dsl_crypt.c` | `dmu_objset_create_crypt_check`, `dsl_dataset_create_crypt_sync`, `dmu_objset_create` | Check: without a new key the dataset must inherit from an encrypted parent whose key is loaded (EACCES otherwise); a new key needs a valid keylocation and keyformat, and a passphrase key a salt and at least 100000 iterations. Needs the encryption and bookmark_v2 features. Sync: a clone takes a reference on its origin's key object; any other encrypted dataset gets a new key object of its own, wrapped with its new wrapping key or with its parent's. A new wrapping key is then loaded into the keystore. Properties: `encryption`. |
| `change_key` | spa_keystore_change_key() | 0 | `sync` | `module/zfs/dsl_crypt.c` | `spa_keystore_change_key`, `spa_keystore_change_key_check`, `spa_keystore_change_key_check_impl`, `spa_keystore_change_key_sync`, `spa_keystore_change_key_sync_impl` | `zfs change-key` as a sync task. Check: the dataset is encrypted and not a clone, the suite is not being changed, the current key is loaded, and every key object that will be rewrapped unwraps with its root's key (ZFS_ERR_CRYPTO_KEY_MISMATCH otherwise). Sync: walks the dataset and every descendant whose encryption root is the same (clones are skipped: they share their origin's key object), rewraps each master key under the new wrapping key and records the new encryption root, then replaces the dataset's wrapping key entry. `-i` does the same with the parent's wrapping key and clears keylocation. |
| `dck_create` | New master key | 1 | `sync` | `module/zfs/dsl_crypt.c` | `dsl_crypto_key_create_sync`, `zio_crypt_key_init`, `dsl_crypto_key_clone_sync` | Creates the DSL Crypto Key ZAP object in the MOS and a random master key (as long as the suite's key: 16, 24 or 32 bytes), a 64-byte HMAC key, a key guid and a first salt. This master key is kept for the life of the dataset and its snapshots. A clone does not get one: it only increments the reference count of its origin's key object. |
| `dck_sync` | Wrap and store master key | 1 | `sync` | `module/zfs/dsl_crypt.c` | `dsl_crypto_key_sync`, `zio_crypt_key_wrap`, `dsl_crypto_key_sync_impl` | Encrypts the master key and HMAC key with the wrapping key under a new random 96-bit IV, and writes the result with its 128-bit MAC into the key object together with the suite, the encryption root's object number, the key guid, and the wrapping key's keyformat, pbkdf2salt and pbkdf2iters. This is all that a change-key rewrites. |
| `dck_zap` | DSL Crypto Key object (MOS) | 1 | `any` | `module/zfs/dsl_crypt.c` | `dsl_dir_get_encryption_root_ddobj`, `dsl_dataset_crypt_stats`, `dsl_crypto_key_destroy_sync` | One ZAP object per encrypted dataset directory, shared by its snapshots and, through a reference count, by its clones. Lives in the MOS, which is not encrypted. Holds the wrapped master and HMAC keys, wrapping IV and MAC, suite, key guid, version, encryption root object number, and keyformat, pbkdf2salt and pbkdf2iters. `zfs get` reads encryptionroot, keyformat and pbkdf2iters from here. Destroyed with the last dataset that references it. Properties: `encryptionroot`, `keyformat`, `pbkdf2iters`, `pbkdf2salt`. |

### 8.5 Shared - DMU, ARC, zio stages (`pipe`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `dbuf_sync` | dbuf_sync_leaf() / dbuf_write() | 0 | `sync` | `module/zfs/dbuf.c` | `dbuf_write`, `dmu_write_policy` | Shared with the I/O flow graph. `dmu_write_policy()` marks every block of an encrypted objset for ENCRYPT. Blocks of encrypted object types keep at most two copies (the third DVA slot holds the salt and IV) and never use nop-write; dedup is allowed only for encrypted types. Properties: `encryption`. |
| `dbuf_read` | dbuf_read() | 0 | `any` | `module/zfs/dbuf.c` | `dbuf_read`, `dbuf_read_impl` | Shared with the I/O flow graph. A normal read asks the ARC for decrypted data. DMU_READ_NO_DECRYPT (raw receive) reads protected blocks raw instead. A cached buffer that is still encrypted or unauthenticated is passed through `arc_untransform()` before it is returned. |
| `arc_read` | arc_read() | 0 | `any` | `module/zfs/arc.c` | `arc_read` | Shared with the I/O flow graph. Without ZIO_FLAG_RAW_ENCRYPT a miss reads the block through a pipeline that decrypts it, and the header keeps the plaintext. With it (raw send, dnode prefetch) the header keeps the ciphertext. Blocks that are only authenticated are always read without checking the MAC; the check is deferred until a consumer fills a buffer with the key loaded. |
| `arc_buf` | arc_buf (consumer copy) | 0 | `any` | `module/zfs/arc.c` | `arc_buf_alloc_impl`, `arc_buf_fill`, `arc_untransform`, `arc_fill_hdr_crypt`, `arc_hdr_decrypt`, `arc_hdr_authenticate` | Shared with the I/O flow graph. Filling a consumer buffer from a protected header: if only ciphertext is cached, `arc_hdr_decrypt()` decrypts it into the header's plaintext copy for this and later hits; if the block was not yet authenticated, `arc_hdr_authenticate()` checks its MAC when the key is loaded and otherwise leaves it unauthenticated. Decryption and MAC errors reach the consumer as EIO. |
| `st_encrypt` | ENCRYPT | 1 | `iss` | `module/zfs/zio.c` | `zio_encrypt` | Shared with the I/O flow graph. Runs after WRITE_COMPRESS, only for newly allocated blocks (and rewritten ZIL blocks). Level-0 blocks of encrypted types are encrypted; other object types in an encrypted objset are authenticated with an HMAC and stay plaintext; indirect blocks store a SHA-512 of their children's MACs; the objset block carries two HMACs. A raw write (raw receive) stores the supplied salt, IV and MAC without using a key. Properties: `encryption`. |
| `st_read_bp_init` | READ_BP_INIT | 1 | `any` | `module/zfs/zio.c` | `zio_read_bp_init` | Shared with the I/O flow graph. For a protected block read without ZIO_FLAG_RAW_ENCRYPT, and for every indirect block of an encrypted objset, pushes `zio_decrypt()` as a transform that runs when the read completes. |
| `st_done` | DONE | 1 | `int` | `module/zfs/zio.c` | `zio_done`, `zio_pop_transforms`, `zio_decrypt` | Shared with the I/O flow graph. `zio_pop_transforms()` runs `zio_decrypt()`: an indirect block has its child-MAC checksum verified (no key needed), an authenticated block its HMAC, an encrypted block is decrypted. A MAC mismatch becomes EIO with an authentication ereport; a missing key is EACCES. |

### 8.6 Block encryption + authentication (`crypt`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `spa_crypt` | spa_do_crypt_abd() and MAC helpers | 0 | `any` | `module/zfs/dsl_crypt.c` | `spa_do_crypt_abd`, `spa_do_crypt_mac_abd`, `spa_do_crypt_objset_mac_abd` | The bridge from the zio and ARC layers to the keystore. Looks up the dataset's master key by objset id, holds it for the call, and runs the operation. When encrypting a normal block it obtains the current salt and a random IV; a dedup block gets salt and IV from an HMAC of its plaintext, so equal blocks encrypt equally; a ZIL block got its salt and IV when its log block was allocated. |
| `salt_iv` | Salt and IV | 0 | `any` | `module/zfs/zio_crypt.c` | `zio_crypt_key_get_salt`, `zio_crypt_key_change_salt`, `zio_crypt_generate_iv`, `zio_crypt_generate_iv_salt_dedup` | Data keys are per salt, not per block: one 64-bit salt and the key derived from it serve many blocks. Every use is counted; after zfs_key_max_salt_uses blocks (default 400,000,000, which is also the maximum) a new random salt is chosen and a new key derived with HKDF. Every unwrap also starts with a fresh salt. The IV is 96 random bits per block. Tunables: `zfs_key_max_salt_uses`. |
| `aead` | AES-GCM / AES-CCM | 1 | `any` | `module/zfs/zio_crypt.c` | `zio_do_crypt_data`, `zio_crypt_init_uios` | Picks the data key for the block's salt: the cached current key if the salt is current, otherwise `hkdf_sha512()` of the master key and that salt. Encrypts or decrypts with AES-GCM or AES-CCM (on QAT hardware when available) and produces or checks a 128-bit MAC. In dnode blocks only the bonus buffers are encrypted; in ZIL blocks the parts needed to claim the log stay plaintext and are covered as authenticated data. |
| `mac` | HMACs and MAC checksums | 1 | `any` | `module/zfs/zio_crypt.c` | `zio_crypt_do_hmac`, `zio_crypt_do_objset_hmacs`, `zio_crypt_do_indirect_mac_checksum_abd` | Authentication without encryption. Unencrypted object types: HMAC-SHA512 with the dataset's HMAC key, truncated to 128 bits. Objset block: a portable MAC (root of the MAC tree in the meta-dnode) and a local MAC (user accounting), 256 bits each, kept inside the block. Indirect blocks: a SHA-512 of their children's MACs, which needs no key, so a raw send can carry the tree without the master key. |
| `bp_crypt` | Crypto fields in the block pointer | 1 | `any` | `module/zfs/zio_crypt.c` | `zio_crypt_encode_params_bp`, `zio_crypt_decode_params_bp`, `zio_crypt_encode_mac_bp`, `zio_crypt_decode_mac_bp` | Where per-block crypto state lives: the 64-bit salt in the first word of DVA[2], the 96-bit IV in the second word of DVA[2] plus the upper 32 bits of blk_fill, and the 128-bit MAC in the second half of blk_cksum; the first half keeps a truncated checksum of the stored bytes, which needs no key. The objset block keeps its MACs inside the block and a ZIL block in its log chain header. |

### 8.7 Raw send + receive (`send`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `raw_send` | Raw send (zfs send -w) | 0 | `syscall` | `module/zfs/dmu_send.c` | `dmu_send`, `dmu_send_impl`, `issue_data_read`, `dmu_dump_write`, `dsl_crypto_populate_key_nvlist` | Sends blocks exactly as stored, so no key needs to be loaded and the stream stays encrypted. The DRR_BEGIN payload carries `crypt_keydata`: the master and HMAC keys still wrapped, with their IV and MAC, suite, key guid and version, the encryption root's keyformat, pbkdf2salt and pbkdf2iters, the portable objset MAC, the meta-dnode layout and IVset guids. Each DRR_WRITE carries its block's salt, IV and MAC. Stream details are in the send/receive graph. |
| `raw_recv` | Raw receive | 1 | `syscall` | `module/zfs/dmu_recv.c` | `dmu_recv_stream`, `dsl_crypto_recv_raw`, `dsl_crypto_recv_raw_key_sync`, `flush_write_batch_impl` | A full raw stream creates the dataset without a key, then a sync task writes a key object holding the received wrapped keys unchanged; the dataset becomes its own encryption root with keylocation=prompt and keystatus unavailable, and loads with the sender's key. Blocks are written raw with the stream's salt, IV and MAC. On an incremental receive into a dataset whose encryption root is another dataset, the key object is only rewritten if that root's keyformat, salt and iterations match the stream's. Tunables: `zfs_disable_ivset_guid_check`. |

## 9. Wires

89 wires. A wire runs from the node that hands something over to the node that receives it. Returns from function calls are mostly not drawn; a wire shows where a key, a payload or control goes next. `on paths` lists the section 10 paths that use the wire.

| wire | from | to | type | label | on paths |
|---|---|---|---|---|---|
| E001 | `zfs_cmd` | `libzfs_crypto` | `ctl` | zfs create: zfs_do_create() -> zfs_create() -> zfs_crypto_create() | create |
| E002 | `zfs_cmd` | `libzfs_crypto` | `ctl` | zfs load-key / unload-key: load_unload_keys() -> load_key_callback() -> zfs_crypto_load_key() or zfs_crypto_unload_key(); with -r or -a only encryption roots | load_key, unload_key |
| E003 | `zfs_cmd` | `libzfs_crypto` | `ctl` | zfs change-key: zfs_do_change_key() -> zfs_crypto_rewrap() | change_key, inherit_key |
| E004 | `zfs_cmd` | `mount_lib` | `ctl` | zfs mount / zfs unmount: zfs_mount() -> zfs_mount_at(), or zfs_unmount(); -l and -u set MS_CRYPT | mount, unload_key |
| E005 | `mount_lib` | `libzfs_crypto` | `ctl` | MS_CRYPT and keystatus unavailable: zfs_crypto_load_key() on the encryption root before mounting | mount |
| E006 | `mount_lib` | `libzfs_crypto` | `ctl` | MS_CRYPT after unmounting an encryption root whose key is loaded: zfs_crypto_unload_key() | unload_key |
| E007 | `libzfs_crypto` | `key_material` | `ctl` | new key: populate_create_encryption_params_nvlists() -> get_key_material(), asking twice at a terminal | create, change_key |
| E008 | `libzfs_crypto` | `key_material` | `ctl` | zfs_crypto_load_key(): pbkdf2salt and pbkdf2iters from the dataset's properties, then get_key_material() from keylocation (or -L) | load_key |
| E009 | `key_material` | `derive_key` | `key` | key material checked by validate_key(), then derive_key() | create, load_key, change_key |
| E010 | `derive_key` | `lzc` | `key` | 32-byte wrapping key; a new passphrase key also gets a new random pbkdf2salt and pbkdf2iters (default 350000) in the properties; passed to lzc_create(), lzc_load_key() or lzc_change_key() | create, load_key, change_key |
| E011 | `libzfs_crypto` | `lzc` | `ctl` | no key material: lzc_create() for an inheriting child, lzc_unload_key(), or lzc_change_key() with DCP_CMD_INHERIT | create, unload_key, inherit_key |
| E012 | `lzc` | `ioc_keys` | `key` | ioctl ZFS_IOC_CREATE, ZFS_IOC_LOAD_KEY, ZFS_IOC_UNLOAD_KEY or ZFS_IOC_CHANGE_KEY; the wrapping key rides in hidden_args, which pool history never records | create, load_key, unload_key, change_key, inherit_key |
| E013 | `ioc_keys` | `dcp` | `key` | dsl_crypto_params_create_nvlist(): command, suite, keylocation and, if one was sent, the wrapping key (dsl_wrapping_key_create()) | create, load_key, change_key, inherit_key |
| E014 | `dcp` | `ks_load` | `key` | spa_keystore_load_wkey(dsname, dcp, noop) | load_key |
| E015 | `ks_load` | `dck_open` | `ctl` | must be the encryption root; dsl_crypto_key_open() tries to unwrap this dataset's key object with the offered key | load_key |
| E016 | `dck_zap` | `dck_open` | `key` | zap_lookup(): suite, key guid, wrapped master and HMAC keys, wrapping IV and MAC, version | load_key, mount |
| E017 | `dck_open` | `ks_load` | `ctl` | zio_crypt_key_unwrap() succeeded, or EACCES for a wrong key (libzfs then re-prompts at a terminal, up to three attempts) | load_key |
| E018 | `ks_load` | `wkey_tree` | `key` | spa_keystore_load_wkey_impl(): wrapping key inserted under the root's dsl_dir object (EEXIST if already loaded); zvol_create_minors() | load_key |
| E019 | `ioc_keys` | `ks_unload` | `ctl` | spa_keystore_unload_wkey(dsname) | unload_key |
| E020 | `ks_unload` | `wkey_tree` | `ctl` | txg_wait_synced(), then spa_keystore_unload_wkey_impl(): EACCES if not loaded, EBUSY while the refcount is not zero, otherwise removed and zeroed by dsl_wrapping_key_free(); zvol_remove_minors() | unload_key |
| E021 | `dcp` | `spa_sync` | `tx` | dmu_objset_create() or spa_keystore_change_key() calls dsl_sync_task(): the check runs once in the calling thread, then the caller waits for the txg that runs the task | create, change_key, inherit_key |
| E022 | `spa_sync` | `create_crypt` | `ctl` | dsl_pool_sync() -> dsl_sync_task_sync(): dmu_objset_create_crypt_check() again, then dmu_objset_create_sync() -> dsl_dataset_create_sync() -> dsl_dataset_create_crypt_sync() | create |
| E023 | `create_crypt` | `wkey_tree` | `ctl` | inheriting: dmu_objset_check_wkey_loaded(parent) must find the parent's wrapping key (EACCES otherwise); the sync step holds it with spa_keystore_wkey_hold_dd() | create |
| E024 | `wkey_tree` | `dck_create` | `key` | inheriting: the encryption root's wrapping key will wrap the new master key | create |
| E025 | `create_crypt` | `dck_create` | `ctl` | dsl_crypto_key_create_sync(crypt, wkey); a clone instead shares its origin's key object through dsl_crypto_key_clone_sync() | create |
| E026 | `dck_create` | `dck_sync` | `key` | zio_crypt_key_init(): new random master key, HMAC key, key guid and salt; dsl_crypto_key_sync() | create |
| E027 | `dck_sync` | `dck_zap` | `key` | zio_crypt_key_wrap() under a new random IV; dsl_crypto_key_sync_impl() writes wrapped keys, IV, MAC, suite, guid, encryption root, keyformat, pbkdf2salt, pbkdf2iters | create, change_key, inherit_key |
| E028 | `create_crypt` | `wkey_tree` | `key` | new encryption root: spa_keystore_load_wkey_impl() loads the new wrapping key, so the dataset can be mounted at once | create |
| E029 | `mount_lib` | `objset_own` | `ctl` | do_mount() -> mount(2); in the kernel zfs_domount() -> zfsvfs_create() -> dmu_objset_own(decrypt = B_TRUE) | mount |
| E030 | `objset_own` | `km_tree` | `ctl` | dsl_dataset_own() -> dsl_dataset_hold_obj_flags(DS_HOLD_FLAG_DECRYPT) -> dsl_dataset_create_key_mapping() -> spa_keystore_create_mapping() | mount |
| E031 | `km_tree` | `dck_tree` | `ctl` | spa_keystore_dsl_key_hold_dd(): reuse the master key if it is already in memory (a snapshot, clone or other open user of the same key object) | mount |
| E032 | `dck_tree` | `wkey_tree` | `ctl` | not in memory: spa_keystore_wkey_hold_dd() finds the wrapping key through the encryption root recorded in the key object; EACCES if it is not loaded | mount |
| E033 | `wkey_tree` | `dck_open` | `key` | the wrapping key: dsl_crypto_key_open() -> zio_crypt_key_unwrap() | mount |
| E034 | `dck_open` | `dck_tree` | `key` | unwrapped master key (fresh salt, HKDF-derived data key); it takes a hold on the wrapping key and is inserted in sk_dsl_keys | mount |
| E035 | `dck_tree` | `km_tree` | `key` | the mapping from dataset object to master key is inserted in sk_key_mappings | mount |
| E036 | `objset_own` | `arc_buf` | `ctl` | dmu_objset_own_impl(): the objset block is still unauthenticated, so arc_untransform() -> arc_buf_fill() checks it now that the key is available | mount |
| E037 | `arc_buf` | `spa_crypt` | `abd` | arc_fill_hdr_crypt() -> arc_hdr_authenticate(): spa_do_crypt_objset_mac_abd() for the objset block, spa_do_crypt_mac_abd() for other authenticated blocks | mount |
| E038 | `spa_crypt` | `km_tree` | `ctl` | spa_keystore_lookup_key(objset id); EACCES if the dataset has no key mapping | mount, write, read |
| E039 | `km_tree` | `spa_crypt` | `key` | master key (dsl_crypto_key_t) with a hold for this one operation | mount, write, read |
| E040 | `spa_crypt` | `mac` | `abd` | zio_crypt_do_objset_hmacs(): portable and local HMAC over the objset block | mount, write |
| E041 | `spa_crypt` | `mac` | `abd` | zio_crypt_do_hmac(): HMAC-SHA512 with the dataset's HMAC key, truncated to 128 bits | write |
| E042 | `mac` | `spa_crypt` | `ctl` | MAC computed; when verifying, compared with the stored one (ECKSUM on mismatch) | mount, write |
| E043 | `spa_crypt` | `arc_buf` | `ctl` | MAC verified: ARC_FLAG_NOAUTH cleared; EACCES (no key) leaves the block unauthenticated without an error | mount |
| E044 | `dbuf_sync` | `st_encrypt` | `abd` | dbuf_write(): dmu_write_policy() sets zp_encrypt; arc_write() -> zio_write(); WRITE_COMPRESS runs first, so ENCRYPT gets the compressed payload | write |
| E045 | `st_encrypt` | `spa_crypt` | `abd` | level-0 block of an encrypted type: spa_do_crypt_abd(B_TRUE, ...) | write |
| E046 | `st_encrypt` | `spa_crypt` | `abd` | other object types in an encrypted objset: spa_do_crypt_mac_abd(B_TRUE, ...); the data stays plaintext | write |
| E047 | `st_encrypt` | `spa_crypt` | `abd` | objset block: spa_do_crypt_objset_mac_abd(B_TRUE, ...) writes both MACs into the block itself | write |
| E048 | `st_encrypt` | `mac` | `abd` | indirect block: zio_crypt_do_indirect_mac_checksum_abd() hashes the children's MACs with SHA-512, no key needed | write |
| E049 | `spa_crypt` | `salt_iv` | `key` | zio_crypt_key_get_salt() (rotating the salt with zio_crypt_key_change_salt() when it is used up) and zio_crypt_generate_iv(); a dedup block uses zio_crypt_generate_iv_salt_dedup() instead | write |
| E050 | `salt_iv` | `aead` | `key` | salt and IV with the master key: zio_do_crypt_data(B_TRUE) uses the cached data key for the current salt | write |
| E051 | `spa_crypt` | `aead` | `abd` | zio_do_crypt_data(B_FALSE) with the salt, IV and MAC of the block; a salt other than the current one gets its key from hkdf_sha512(master key, salt) | read |
| E052 | `aead` | `spa_crypt` | `abd` | zio_encrypt_os(): ciphertext and 128-bit MAC; zio_decrypt_os(): plaintext, or ECKSUM when the MAC does not match | write, read |
| E053 | `mac` | `st_encrypt` | `bp` | checksum of the children's MACs, stored in the MAC field | write |
| E054 | `spa_crypt` | `st_encrypt` | `abd` | back in zio_encrypt(): ciphertext pushed as the write transform plus MAC, or the MAC alone for an authenticated type; the objset block already holds its MACs | write |
| E055 | `st_encrypt` | `bp_crypt` | `bp` | zio_crypt_encode_params_bp() (salt and IV of an encrypted block) and zio_crypt_encode_mac_bp() (every block but the objset block); the checksum computed next covers the stored bytes | write, raw_send_recv |
| E056 | `dbuf_read` | `arc_read` | `ctl` | dbuf_read_impl(): arc_read() without ZIO_FLAG_RAW, asking for plaintext | read |
| E057 | `arc_read` | `st_read_bp_init` | `zio` | miss: zio_read() of the block | read |
| E058 | `st_read_bp_init` | `st_done` | `zio` | protected block: zio_push_transform(zio_decrypt); after the device read (I/O graph path read_miss) zio_done() runs zio_pop_transforms() | read |
| E059 | `st_done` | `bp_crypt` | `bp` | zio_decrypt(): zio_crypt_decode_params_bp(), zio_crypt_decode_mac_bp() (a ZIL block: zio_crypt_decode_mac_zil() from its header) | read |
| E060 | `st_done` | `spa_crypt` | `abd` | zio_decrypt(): spa_do_crypt_abd(B_FALSE, ...) | read |
| E061 | `spa_crypt` | `st_done` | `abd` | plaintext (still compressed); ECKSUM becomes EIO plus an authentication ereport | read |
| E062 | `st_done` | `arc_buf` | `arc` | done callback arc_read_done(): the header keeps the plaintext; arc_buf_alloc_impl() for every waiting caller | read |
| E063 | `arc_read` | `arc_buf` | `arc` | hit on a header that holds only ciphertext (left by a raw reader): arc_buf_alloc_impl() -> arc_buf_fill() -> arc_fill_hdr_crypt() | read |
| E064 | `arc_buf` | `spa_crypt` | `abd` | arc_hdr_decrypt(): spa_do_crypt_abd(B_FALSE, ...) with the salt, IV and MAC saved in the header | read |
| E065 | `spa_crypt` | `arc_buf` | `abd` | plaintext kept in the header for later hits; an error marks the header ARC_FLAG_IO_ERROR | read |
| E066 | `arc_buf` | `dbuf_read` | `arc` | callback dbuf_read_done(): the consumer gets plaintext | read |
| E067 | `spa_sync` | `change_key` | `ctl` | dsl_pool_sync() -> dsl_sync_task_sync(): spa_keystore_change_key_check() again, then spa_keystore_change_key_sync() | change_key, inherit_key |
| E068 | `change_key` | `wkey_tree` | `ctl` | check: dmu_objset_check_wkey_loaded() for the dataset (and for -i its parent), EACCES if not loaded; every key to be rewrapped must unwrap (ZFS_ERR_CRYPTO_KEY_MISMATCH) | change_key, inherit_key |
| E069 | `wkey_tree` | `change_key` | `key` | -i: spa_keystore_wkey_hold_dd(parent) returns the wrapping key of the parent's encryption root | inherit_key |
| E070 | `change_key` | `dck_tree` | `ctl` | spa_keystore_change_key_sync_impl(): for the dataset and each descendant with the same encryption root (clones skipped), spa_keystore_dsl_key_hold_dd(), unwrapping with the old key if not in memory | change_key, inherit_key |
| E071 | `dck_tree` | `dck_sync` | `key` | the same master key with dck_wkey switched to the new wrapping key: dsl_crypto_key_sync() | change_key, inherit_key |
| E072 | `change_key` | `wkey_tree` | `key` | the dataset's own wrapping key entry is removed and freed; a new key is inserted in its place, making the dataset an encryption root | change_key, inherit_key |
| E073 | `objset_own` | `km_tree` | `ctl` | unmount: zfs_umount() -> dmu_objset_disown() -> dsl_dataset_rele_flags() -> dsl_dataset_remove_key_mapping() -> spa_keystore_remove_mapping() | unload_key |
| E074 | `km_tree` | `dck_tree` | `ctl` | key_mapping_rele(): the last reference frees the mapping and calls spa_keystore_dsl_key_rele() | unload_key |
| E075 | `dck_tree` | `wkey_tree` | `ctl` | refcount zero: dsl_crypto_key_free() zeroes the master key and drops its hold with dsl_wrapping_key_rele() | unload_key |
| E076 | `mount_lib` | `objset_own` | `ctl` | unmount_one() -> umount2(2); in the kernel zfs_umount() | unload_key |
| E077 | `zfs_cmd` | `raw_send` | `ctl` | zfs send -w sets flags.raw; dmu_send() with rawok holds the snapshot without DS_HOLD_FLAG_DECRYPT, so no key needs to be loaded | raw_send_recv |
| E078 | `dck_zap` | `raw_send` | `key` | dsl_crypto_populate_key_nvlist(): wrapped master and HMAC keys with IV and MAC, suite, guid, version, the root's keyformat, pbkdf2salt, pbkdf2iters, portable_mac, meta-dnode layout, IVset guids; added to DRR_BEGIN as crypt_keydata | raw_send_recv |
| E079 | `raw_send` | `arc_read` | `ctl` | issue_data_read(): arc_read() with ZIO_FLAG_RAW | raw_send_recv |
| E080 | `arc_read` | `raw_send` | `abd` | the block exactly as stored: ciphertext, or plaintext plus MAC for an authenticated type | raw_send_recv |
| E081 | `bp_crypt` | `raw_send` | `bp` | dmu_dump_write(): zio_crypt_decode_params_bp() and zio_crypt_decode_mac_bp() fill drr_salt, drr_iv and drr_mac of the DRR_WRITE record | raw_send_recv |
| E082 | `raw_send` | `raw_recv` | `abd` | the stream: DRR_BEGIN with crypt_keydata, then records with the stored bytes and their salt, IV and MAC | raw_send_recv |
| E083 | `raw_recv` | `dck_zap` | `key` | dsl_crypto_recv_raw() sync task -> dsl_crypto_recv_raw_key_sync(): a new dataset gets keylocation "prompt", itself as encryption root, and dsl_crypto_key_sync_impl() stores the received wrapped keys unchanged; an existing dataset gets them at the end of the receive | raw_send_recv |
| E084 | `raw_recv` | `st_encrypt` | `abd` | flush_write_batch_impl(): ZIO_FLAG_RAW and the record's salt, IV and MAC; dmu_lightweight_write_by_dnode(); at txg sync zio_encrypt() takes the ZIO_FLAG_RAW_ENCRYPT branch and uses no key | raw_send_recv |
| E085 | `admin` | `zfs_cmd` | `ctl` | runs zfs create -o encryption=on -o keyformat=... -o keylocation=... dataset | create |
| E086 | `admin` | `zfs_cmd` | `ctl` | runs zfs load-key or zfs unload-key [-r | -a] | load_key |
| E087 | `admin` | `zfs_cmd` | `ctl` | runs zfs mount [-l] or zfs unmount [-u] | mount, unload_key |
| E088 | `admin` | `zfs_cmd` | `ctl` | runs zfs change-key [-l] [-o keyformat=...] or zfs change-key -i | change_key, inherit_key |
| E089 | `admin` | `zfs_cmd` | `ctl` | runs zfs send -w (raw) snapshot, piped into zfs receive | raw_send_recv |

## 10. Paths

9 named paths, 129 steps in total. Each step is one wire; the caption for a step is that wire's label. Every wire in section 9 is on at least one path. The category is the heading the path is listed under in the left panel. Path syntax, alternatives and notes are defined in section 10 of `../zfs-io-flow-diagram-spec.md`.

### 10.1 `create` - Create an encrypted dataset

Category: Key management. `zfs create -o encryption=on -o keyformat=passphrase pool/secret`, or a plain `zfs create pool/secret/child` under an encrypted parent. Either way the new dataset gets its own random master key; what differs is which wrapping key wraps it.

Alternatives:
- `root`: `newroot` New encryption root (keyformat given, own wrapping key); `inherit` Child of an encrypted parent, wrapped with the parent's encryption root key

```
 1  E085  admin -> zfs_cmd
 2  E001  zfs_cmd -> libzfs_crypto
 3  E007  libzfs_crypto -> key_material  [root: newroot]
 4  E009  key_material -> derive_key  [root: newroot]
 5  E010  derive_key -> lzc  [root: newroot]
 6  E011  libzfs_crypto -> lzc  [root: inherit]
 7  E012  lzc -> ioc_keys
 8  E013  ioc_keys -> dcp
 9  E021  dcp -> spa_sync
10  E022  spa_sync -> create_crypt
11  E023  create_crypt -> wkey_tree  [root: inherit]
12  E024  wkey_tree -> dck_create  [root: inherit]
13  E025  create_crypt -> dck_create
14  E026  dck_create -> dck_sync
15  E027  dck_sync -> dck_zap
16  E028  create_crypt -> wkey_tree  [root: newroot]
```
Ends: The dataset has a DSL Crypto Key object whose encryption root is itself (newroot) or the parent's root (inherit). Its wrapping key is loaded, so `zfs create` goes on to mount it (path mount).

### 10.2 `load_key` - zfs load-key

Category: Key management. Loads the wrapping key of an encryption root. Nothing is decrypted yet: the key is only proved by unwrapping the root's own master key, and that copy is thrown away again.

Alternatives:
- `fmt`: `passphrase` keyformat=passphrase; `rawhex` keyformat=raw or keyformat=hex

```
 1  E086  admin -> zfs_cmd
 2  E002  zfs_cmd -> libzfs_crypto
 3  E008  libzfs_crypto -> key_material
 4  E009  key_material -> derive_key  [fmt: passphrase]  "PBKDF2-HMAC-SHA1 over the passphrase with pbkdf2salt and pbkdf2iters: the slow step that protects against guessing"
 5  E009  key_material -> derive_key  [fmt: rawhex]  "raw: the 32 bytes are the wrapping key; hex: 64 hex digits decoded to 32 bytes"
 6  E010  derive_key -> lzc
 7  E012  lzc -> ioc_keys
 8  E013  ioc_keys -> dcp
 9  E014  dcp -> ks_load
10  E015  ks_load -> dck_open
11  E016  dck_zap -> dck_open
12  E017  dck_open -> ks_load
13  E018  ks_load -> wkey_tree
```
Ends: The wrapping key is in the keystore. keystatus is `available` for the root and for every dataset whose encryption root it is. No master key is in memory until a dataset is opened (path mount).

### 10.3 `mount` - Mount: master key unwrapped, key mapping created

Category: Key management. Opening a dataset for decryption is where a master key is unwrapped and bound to the dataset. From then on every block I/O of the dataset finds its key by objset id.

Alternatives:
- `how`: `l` zfs mount -l (loads the encryption root's key first if needed, as in path load_key); `loaded` key already loaded
- `master`: `cold` master key not in memory yet; `warm` already in memory (another open snapshot, clone or user of the same key object)

```
 1  E087  admin -> zfs_cmd
 2  E004  zfs_cmd -> mount_lib
 3  E005  mount_lib -> libzfs_crypto  [how: l]
 4  E029  mount_lib -> objset_own
 5  E030  objset_own -> km_tree
 6  E031  km_tree -> dck_tree
 7  E032  dck_tree -> wkey_tree  [master: cold]
 8  E033  wkey_tree -> dck_open  [master: cold]
 9  E016  dck_zap -> dck_open  [master: cold]
10  E034  dck_open -> dck_tree  [master: cold]
11  E035  dck_tree -> km_tree
12  E036  objset_own -> arc_buf
13  E037  arc_buf -> spa_crypt
14  E038  spa_crypt -> km_tree
15  E039  km_tree -> spa_crypt
16  E040  spa_crypt -> mac
17  E042  mac -> spa_crypt
18  E043  spa_crypt -> arc_buf
```
Ends: The dataset is owned with a key mapping, its objset block is authenticated, and its master key is held by the mapping (and holds the wrapping key). Reads and writes now work (paths read and write).

### 10.4 `write` - Write a block: encrypt or authenticate

Category: Data path. A dirty block of an encrypted dataset on its way to disk at txg sync. What ENCRYPT does depends on the block.

Alternatives:
- `block`: `data` Level-0 block of an encrypted type (file data, directories, dnodes, ZIL, zvol data); `auth` Level-0 block of an unencrypted type (for example the ZFS master node): authenticated only; `objset` The objset block: two embedded HMACs; `indirect` Indirect block: hash of the children's MACs

```
 1  E044  dbuf_sync -> st_encrypt  [block: data, auth, indirect]
 2  E044  dbuf_sync -> st_encrypt  [block: objset]  "the objset block is written the same way, by dmu_objset_sync()"
 3  E045  st_encrypt -> spa_crypt  [block: data]
 4  E046  st_encrypt -> spa_crypt  [block: auth]
 5  E047  st_encrypt -> spa_crypt  [block: objset]
 6  E048  st_encrypt -> mac  [block: indirect]
 7  E053  mac -> st_encrypt  [block: indirect]
 8  E038  spa_crypt -> km_tree  [block: data, auth, objset]
 9  E039  km_tree -> spa_crypt  [block: data, auth, objset]
10  E049  spa_crypt -> salt_iv  [block: data]
11  E050  salt_iv -> aead  [block: data]
12  E052  aead -> spa_crypt  [block: data]
13  E041  spa_crypt -> mac  [block: auth]
14  E040  spa_crypt -> mac  [block: objset]
15  E042  mac -> spa_crypt  [block: auth, objset]
16  E054  spa_crypt -> st_encrypt  [block: data, auth, objset]
17  E055  st_encrypt -> bp_crypt  [block: data, auth, indirect]
```
Ends: The block pointer carries the salt, IV and MAC (or the MAC, or the MAC checksum); CHECKSUM_GENERATE and allocation follow as in the I/O graph's path `zfs-io-flow:txg_sync`. Without a key mapping the write cannot happen, which is why unload-key waits for a txg sync and refuses while datasets are open.

### 10.5 `read` - Read a block: decrypt

Category: Data path. A normal (not raw) read of an encrypted block. The data key is recomputed from the master key and the salt stored in the block pointer.

Alternatives:
- `cache`: `miss` ARC miss: decrypted by the read pipeline; `rawhdr` ARC hit on a header that holds only ciphertext: decrypted by the ARC

```
 1  E056  dbuf_read -> arc_read
 2  E057  arc_read -> st_read_bp_init  [cache: miss]
 3  E058  st_read_bp_init -> st_done  [cache: miss]
 4  E059  st_done -> bp_crypt  [cache: miss]
 5  E060  st_done -> spa_crypt  [cache: miss]
 6  E063  arc_read -> arc_buf  [cache: rawhdr]
 7  E064  arc_buf -> spa_crypt  [cache: rawhdr]
 8  E038  spa_crypt -> km_tree
 9  E039  km_tree -> spa_crypt
10  E051  spa_crypt -> aead
11  E052  aead -> spa_crypt
12  E061  spa_crypt -> st_done  [cache: miss]
13  E062  st_done -> arc_buf  [cache: miss]
14  E065  spa_crypt -> arc_buf  [cache: rawhdr]
15  E066  arc_buf -> dbuf_read
```
Ends: The consumer has plaintext and the ARC header keeps a decrypted copy. With the key unloaded, the key lookup fails with EACCES; a tampered block fails its MAC and returns EIO.

### 10.6 `change_key` - zfs change-key: new wrapping key, no data rewritten

Category: Key management. A passphrase change, or turning a dataset that inherited its key into a new encryption root. Only the wrapped copies of the master keys are rewritten; every data block stays as it is.

Alternatives:
- `target`: `root` The dataset is already an encryption root (for example a new passphrase); `child` The dataset inherited its key and becomes a new encryption root

```
 1  E088  admin -> zfs_cmd
 2  E003  zfs_cmd -> libzfs_crypto
 3  E007  libzfs_crypto -> key_material  [target: root]  "keyformat and keylocation default to the current ones"
 4  E007  libzfs_crypto -> key_material  [target: child]  "keyformat is required; keylocation defaults to prompt"
 5  E009  key_material -> derive_key
 6  E010  derive_key -> lzc
 7  E012  lzc -> ioc_keys
 8  E013  ioc_keys -> dcp
 9  E021  dcp -> spa_sync
10  E067  spa_sync -> change_key
11  E068  change_key -> wkey_tree
12  E070  change_key -> dck_tree
13  E071  dck_tree -> dck_sync
14  E027  dck_sync -> dck_zap
15  E072  change_key -> wkey_tree
```
Ends: The key objects of the dataset and of every descendant under the same encryption root hold the same master keys wrapped with the new key; the old wrapping key is freed from memory and no key object in the pool is wrapped with it any more. A raw send stream made earlier still carries the master key wrapped with the old key.

### 10.7 `inherit_key` - zfs change-key -i: rejoin the parent's encryption root

Category: Key management. An encryption root gives up its own key and wraps its master keys (and those of its descendants under it) with the parent's encryption root key.

```
 1  E088  admin -> zfs_cmd
 2  E003  zfs_cmd -> libzfs_crypto
 3  E011  libzfs_crypto -> lzc
 4  E012  lzc -> ioc_keys
 5  E013  ioc_keys -> dcp
 6  E021  dcp -> spa_sync
 7  E067  spa_sync -> change_key
 8  E068  change_key -> wkey_tree
 9  E069  wkey_tree -> change_key
10  E070  change_key -> dck_tree
11  E071  dck_tree -> dck_sync
12  E027  dck_sync -> dck_zap
13  E072  change_key -> wkey_tree
```
Ends: encryptionroot of the dataset and its inheriting descendants is now the parent's encryption root, keylocation is cleared, and loading the parent's root key gives access to all of them.

### 10.8 `unload_key` - Unmount and zfs unload-key

Category: Key management. Removing the wrapping key from memory. It only succeeds once no dataset under the encryption root still holds a master key.

Alternatives:
- `how`: `umount_u` zfs unmount -u: unmount, then unload; `unload` zfs unload-key on datasets that are already unmounted (fails with EBUSY if one is still mounted)

```
 1  E087  admin -> zfs_cmd
 2  E004  zfs_cmd -> mount_lib  [how: umount_u]
 3  E076  mount_lib -> objset_own  [how: umount_u]
 4  E073  objset_own -> km_tree  [how: umount_u]
 5  E074  km_tree -> dck_tree  [how: umount_u]
 6  E075  dck_tree -> wkey_tree  [how: umount_u]
 7  E006  mount_lib -> libzfs_crypto  [how: umount_u]
 8  E002  zfs_cmd -> libzfs_crypto  [how: unload]
 9  E011  libzfs_crypto -> lzc
10  E012  lzc -> ioc_keys
11  E019  ioc_keys -> ks_unload
12  E020  ks_unload -> wkey_tree
```
Ends: keystatus is `unavailable`. The master keys in memory were zeroed when their last holder went away; the key objects on disk are unchanged.

### 10.9 `raw_send_recv` - Raw send and receive (zfs send -w)

Category: Replication. Replicating an encrypted dataset without its key: the blocks travel as stored and the master key travels still wrapped.

```
 1  E089  admin -> zfs_cmd
 2  E077  zfs_cmd -> raw_send
 3  E078  dck_zap -> raw_send
 4  E079  raw_send -> arc_read
 5  E080  arc_read -> raw_send
 6  E081  bp_crypt -> raw_send
 7  E082  raw_send -> raw_recv
 8  E083  raw_recv -> dck_zap
 9  E084  raw_recv -> st_encrypt
10  E055  st_encrypt -> bp_crypt
```
Ends: The received dataset is its own encryption root with keystatus `unavailable`; `zfs load-key` with the sender's passphrase or key opens it, because keyformat, pbkdf2salt and pbkdf2iters came along. Neither side decrypted anything. The stream format and receive mechanics are in the send/receive graph: `zfs-send-receive:raw_send` and `zfs-send-receive:raw_recv`.

## 11. Accuracy rules and known simplifications

Rules: every function, line, tunable and property in this spec was checked at the pinned commit. OS-specific pieces use Linux names (`zfsvfs_create`, `zfs_umount`).

Simplifications made on purpose. State these in the page's About overlay so nobody mistakes the diagram for the whole truth:

1. The data paths jump over pipeline stages and the vdev layer drawn in the I/O graph: `dbuf_write()` to ENCRYPT, READ_BP_INIT to DONE and the device read in between are single wires here.
2. A sync task's check function runs twice, once in the calling thread and once in syncing context; the diagram draws the check where its effect matters, once.
3. Returns are drawn only where a result or error matters; most holds and releases of keys during a single I/O are folded into the lookup wires.
4. ZIL encryption (salt and IV chosen at log block allocation, MAC in the log chain header), encrypted dedup and dnode bonus-buffer encryption are described in node text only.
5. Snapshots and clones share a key object and are not drawn separately; `zfs promote`, `zfs rename` and the forced change-key commands are left out.
6. The crypto back ends (ICP, Linux kernel crypto API, FreeBSD crypto, QAT) are folded into the AES-GCM / AES-CCM node.
7. Raw send and receive are reduced to their key data; the stream itself belongs to the send/receive graph.

## 12. Build order

See `../zfs-io-flow-diagram-spec.md` section 12 and `zfs-viewer-suite-spec.md`.

## 13. Acceptance checklist

- Counts: 36 nodes, 89 wires, 9 paths, 129 path steps, 7 groups, 7 wire types, 124 functions in the index, 215 wire references (Appendix C), 9 tunable and property references (Appendix D).
- Activating path `write` with the default alternative (`block: data`) highlights 9 distinct wires and plays 9 steps; `read` highlights 12 and plays 12; `load_key` highlights 12 and plays 12.
- Node `wkey_tree` lists 8 incoming and 3 outgoing wires.
- The eight shared nodes (`spa_sync`, `dbuf_sync`, `dbuf_read`, `arc_read`, `arc_buf`, `st_encrypt`, `st_read_bp_init`, `st_done`) show "Also in: ZFS I/O Flow" and keep the I/O graph's titles and contexts.
- Searching `zfs_key_max_salt_uses` finds `salt_iv`; searching `encryptionroot` finds `libzfs_crypto` and `dck_zap`.
- The About overlay contains the seven mental-model points and the seven simplifications.

## Appendix A. Function index

Functions named in section 8, with file and line at commit `c913da8615`.

```
arc_buf_alloc_impl  module/zfs/arc.c:2774
arc_buf_fill  module/zfs/arc.c:2034
arc_fill_hdr_crypt  module/zfs/arc.c:1955
arc_hdr_authenticate  module/zfs/arc.c:1820
arc_hdr_decrypt  module/zfs/arc.c:1888
arc_read  module/zfs/arc.c:5905
arc_untransform  module/zfs/arc.c:2229
dbuf_read  module/zfs/dbuf.c:1796
dbuf_read_impl  module/zfs/dbuf.c:1627
dbuf_write  module/zfs/dbuf.c:5450
derive_key  lib/libzfs/libzfs_crypto.c:761
dmu_dump_write  module/zfs/dmu_send.c:445
dmu_objset_check_wkey_loaded  module/zfs/dsl_crypt.c:1148
dmu_objset_create  module/zfs/dmu_objset.c:1332
dmu_objset_create_crypt_check  module/zfs/dsl_crypt.c:1924
dmu_objset_disown  module/zfs/dmu_objset.c:923
dmu_objset_own  module/zfs/dmu_objset.c:807
dmu_recv_stream  module/zfs/dmu_recv.c:5210
dmu_send  module/zfs/dmu_send.c:2836
dmu_send_impl  module/zfs/dmu_send.c:2449
dmu_write_policy  module/zfs/dmu.c:2563
dsl_crypto_key_clone_sync  module/zfs/dsl_crypt.c:2776
dsl_crypto_key_create_sync  module/zfs/dsl_crypt.c:2744
dsl_crypto_key_destroy_sync  module/zfs/dsl_crypt.c:2789
dsl_crypto_key_free  module/zfs/dsl_crypt.c:517
dsl_crypto_key_open  module/zfs/dsl_crypt.c:541
dsl_crypto_key_sync  module/zfs/dsl_crypt.c:1215
dsl_crypto_key_sync_impl  module/zfs/dsl_crypt.c:1187
dsl_crypto_params_create_nvlist  module/zfs/dsl_crypt.c:133
dsl_crypto_params_free  module/zfs/dsl_crypt.c:241
dsl_crypto_populate_key_nvlist  module/zfs/dsl_crypt.c:2589
dsl_crypto_recv_raw  module/zfs/dsl_crypt.c:2573
dsl_crypto_recv_raw_key_sync  module/zfs/dsl_crypt.c:2394
dsl_dataset_create_crypt_sync  module/zfs/dsl_crypt.c:2034
dsl_dataset_create_key_mapping  module/zfs/dsl_dataset.c:780
dsl_dataset_crypt_stats  module/zfs/dsl_crypt.c:2807
dsl_dataset_get_keystatus  module/zfs/dsl_crypt.c:1164
dsl_dataset_hold_obj_flags  module/zfs/dsl_dataset.c:792
dsl_dataset_rele_flags  module/zfs/dsl_dataset.c:1023
dsl_dataset_remove_key_mapping  module/zfs/dsl_dataset.c:1011
dsl_dir_get_encryption_root_ddobj  module/zfs/dsl_crypt.c:349
dsl_sync_task  module/zfs/dsl_synctask.c:126
dsl_sync_task_sync  module/zfs/dsl_synctask.c:207
dsl_wrapping_key_create  module/zfs/dsl_crypt.c:109
dsl_wrapping_key_free  module/zfs/dsl_crypt.c:93
flush_write_batch_impl  module/zfs/dmu_recv.c:3768
get_key_interactive  lib/libzfs/libzfs_crypto.c:355
get_key_material  lib/libzfs/libzfs_crypto.c:671
get_key_material_file  lib/libzfs/libzfs_crypto.c:478
get_key_material_https  lib/libzfs/libzfs_crypto.c:505
hex_key_to_raw  lib/libzfs/libzfs_crypto.c:148
issue_data_read  module/zfs/dmu_send.c:1623
key_mapping_rele  module/zfs/dsl_crypt.c:979
load_key_callback  cmd/zfs/zfs_main.c:8680
load_unload_keys  cmd/zfs/zfs_main.c:8720
lzc_change_key  lib/libzfs_core/libzfs_core.c:1867
lzc_create  lib/libzfs_core/libzfs_core.c:296
lzc_ioctl  lib/libzfs_core/libzfs_core.c:212
lzc_load_key  lib/libzfs_core/libzfs_core.c:1837
lzc_unload_key  lib/libzfs_core/libzfs_core.c:1861
populate_create_encryption_params_nvlists  lib/libzfs/libzfs_crypto.c:835
share_mount_one  cmd/zfs/zfs_main.c:7086
spa_do_crypt_abd  module/zfs/dsl_crypt.c:2983
spa_do_crypt_mac_abd  module/zfs/dsl_crypt.c:2940
spa_do_crypt_objset_mac_abd  module/zfs/dsl_crypt.c:2878
spa_keystore_change_key  module/zfs/dsl_crypt.c:1762
spa_keystore_change_key_check  module/zfs/dsl_crypt.c:1368
spa_keystore_change_key_check_impl  module/zfs/dsl_crypt.c:1262
spa_keystore_change_key_sync  module/zfs/dsl_crypt.c:1659
spa_keystore_change_key_sync_impl  module/zfs/dsl_crypt.c:1561
spa_keystore_create_mapping  module/zfs/dsl_crypt.c:1010
spa_keystore_dsl_key_hold_dd  module/zfs/dsl_crypt.c:657
spa_keystore_dsl_key_rele  module/zfs/dsl_crypt.c:715
spa_keystore_load_wkey  module/zfs/dsl_crypt.c:754
spa_keystore_load_wkey_impl  module/zfs/dsl_crypt.c:728
spa_keystore_lookup_key  module/zfs/dsl_crypt.c:1107
spa_keystore_remove_mapping  module/zfs/dsl_crypt.c:1069
spa_keystore_unload_wkey  module/zfs/dsl_crypt.c:903
spa_keystore_unload_wkey_impl  module/zfs/dsl_crypt.c:867
spa_keystore_wkey_hold_dd  module/zfs/dsl_crypt.c:418
spa_sync  module/zfs/spa.c:11405
spa_sync_iterate_to_convergence  module/zfs/spa.c:11192
unshare_unmount  cmd/zfs/zfs_main.c:7794
validate_key  lib/libzfs/libzfs_crypto.c:199
zfs_create  lib/libzfs/libzfs_dataset.c:3631
zfs_crypto_create  lib/libzfs/libzfs_crypto.c:987
zfs_crypto_get_encryption_root  lib/libzfs/libzfs_crypto.c:956
zfs_crypto_load_key  lib/libzfs/libzfs_crypto.c:1261
zfs_crypto_rewrap  lib/libzfs/libzfs_crypto.c:1585
zfs_crypto_unload_key  lib/libzfs/libzfs_crypto.c:1435
zfs_do_change_key  cmd/zfs/zfs_main.c:8813
zfs_do_create  cmd/zfs/zfs_main.c:1087
zfs_do_load_key  cmd/zfs/zfs_main.c:8800
zfs_do_send  cmd/zfs/zfs_main.c:4753
zfs_do_unload_key  cmd/zfs/zfs_main.c:8807
zfs_ioc_change_key  module/zfs/zfs_ioctl.c:7856
zfs_ioc_create  module/zfs/zfs_ioctl.c:3973
zfs_ioc_load_key  module/zfs/zfs_ioctl.c:7776
zfs_ioc_unload_key  module/zfs/zfs_ioctl.c:7818
zfs_mount_at  lib/libzfs/libzfs_mount.c:390
zfs_umount  module/os/linux/zfs/zfs_vfsops.c:1612
zfs_unmount  lib/libzfs/libzfs_mount.c:622
zfsvfs_create  module/os/linux/zfs/zfs_vfsops.c:642
zio_crypt_decode_mac_bp  module/zfs/zio_crypt.c:625
zio_crypt_decode_params_bp  module/zfs/zio_crypt.c:571
zio_crypt_do_hmac  module/zfs/zio_crypt.c:503
zio_crypt_do_indirect_mac_checksum_abd  module/zfs/zio_crypt.c:1101
zio_crypt_do_objset_hmacs  module/zfs/zio_crypt.c:904
zio_crypt_encode_mac_bp  module/zfs/zio_crypt.c:604
zio_crypt_encode_params_bp  module/zfs/zio_crypt.c:546
zio_crypt_generate_iv  module/zfs/zio_crypt.c:486
zio_crypt_generate_iv_salt_dedup  module/zfs/zio_crypt.c:520
zio_crypt_init_uios  module/zfs/zio_crypt.c:1472
zio_crypt_key_change_salt  module/zfs/zio_crypt.c:277
zio_crypt_key_get_salt  module/zfs/zio_crypt.c:320
zio_crypt_key_init  module/zfs/zio_crypt.c:219
zio_crypt_key_unwrap  module/zfs/zio_crypt.c:402
zio_crypt_key_wrap  module/zfs/zio_crypt.c:346
zio_decrypt  module/zfs/zio.c:562
zio_do_crypt_data  module/zfs/zio_crypt.c:1512
zio_done  module/zfs/zio.c:6065
zio_encrypt  module/zfs/zio.c:5567
zio_pop_transforms  module/zfs/zio.c:511
zio_read_bp_init  module/zfs/zio.c:1865
```

## Appendix C. Wire source references

References for the 84 wires, at commit `c913da8615`. Each line is `<wire>  <file>:<line>  <symbol>`, and the symbol appears verbatim on that source line. A wire's references are listed in the order of the calls in its label.

```
E001  cmd/zfs/zfs_main.c:1348  zfs_create
E001  lib/libzfs/libzfs_dataset.c:3748  zfs_crypto_create
E002  cmd/zfs/zfs_main.c:8783  load_key_callback
E002  cmd/zfs/zfs_main.c:8707  zfs_crypto_load_key
E002  cmd/zfs/zfs_main.c:8709  zfs_crypto_unload_key
E003  cmd/zfs/zfs_main.c:8875  zfs_crypto_rewrap
E004  cmd/zfs/zfs_main.c:7307  zfs_mount
E004  lib/libzfs/libzfs_mount.c:383  zfs_mount_at
E004  cmd/zfs/zfs_main.c:7962  zfs_unmount
E004  cmd/zfs/zfs_main.c:7435  MS_CRYPT
E004  cmd/zfs/zfs_main.c:7814  MS_CRYPT
E005  lib/libzfs/libzfs_mount.c:456  MS_CRYPT
E005  lib/libzfs/libzfs_mount.c:473  zfs_crypto_load_key
E006  lib/libzfs/libzfs_mount.c:669  MS_CRYPT
E006  lib/libzfs/libzfs_mount.c:681  zfs_crypto_unload_key
E007  lib/libzfs/libzfs_crypto.c:1133  populate_create_encryption_params_nvlists
E007  lib/libzfs/libzfs_crypto.c:1717  populate_create_encryption_params_nvlists
E007  lib/libzfs/libzfs_crypto.c:848  get_key_material
E008  lib/libzfs/libzfs_crypto.c:1345  ZFS_PROP_PBKDF2_SALT
E008  lib/libzfs/libzfs_crypto.c:1354  get_key_material
E009  lib/libzfs/libzfs_crypto.c:735  validate_key
E009  lib/libzfs/libzfs_crypto.c:904  derive_key
E009  lib/libzfs/libzfs_crypto.c:1361  derive_key
E010  lib/libzfs/libzfs_crypto.c:856  pkcs11_get_urandom
E010  lib/libzfs/libzfs_crypto.c:880  DEFAULT_PBKDF2_ITERATIONS
E010  lib/libzfs/libzfs_dataset.c:3755  lzc_create
E010  lib/libzfs/libzfs_crypto.c:1369  lzc_load_key
E010  lib/libzfs/libzfs_crypto.c:1779  lzc_change_key
E011  lib/libzfs/libzfs_dataset.c:3755  lzc_create
E011  lib/libzfs/libzfs_crypto.c:1491  lzc_unload_key
E011  lib/libzfs/libzfs_crypto.c:1593  DCP_CMD_INHERIT
E011  lib/libzfs/libzfs_crypto.c:1779  lzc_change_key
E012  lib/libzfs_core/libzfs_core.c:314  ZFS_IOC_CREATE
E012  lib/libzfs_core/libzfs_core.c:1853  ZFS_IOC_LOAD_KEY
E012  lib/libzfs_core/libzfs_core.c:1863  ZFS_IOC_UNLOAD_KEY
E012  lib/libzfs_core/libzfs_core.c:1886  ZFS_IOC_CHANGE_KEY
E012  module/zfs/spa_history.c:372  ZPOOL_HIDDEN_ARGS
E013  module/zfs/zfs_ioctl.c:4052  dsl_crypto_params_create_nvlist
E013  module/zfs/zfs_ioctl.c:7791  dsl_crypto_params_create_nvlist
E013  module/zfs/zfs_ioctl.c:7873  dsl_crypto_params_create_nvlist
E013  module/zfs/dsl_crypt.c:215  dsl_wrapping_key_create
E014  module/zfs/zfs_ioctl.c:7796  spa_keystore_load_wkey
E015  module/zfs/dsl_crypt.c:791  dsl_dir_get_encryption_root_ddobj
E015  module/zfs/dsl_crypt.c:801  dsl_crypto_key_open
E016  module/zfs/dsl_crypt.c:571  DSL_CRYPTO_KEY_MASTER_KEY
E017  module/zfs/dsl_crypt.c:598  zio_crypt_key_unwrap
E017  module/zfs/dsl_crypt.c:601  EACCES
E017  lib/libzfs/libzfs_crypto.c:1429  try_again
E018  module/zfs/dsl_crypt.c:842  spa_keystore_load_wkey_impl
E018  module/zfs/dsl_crypt.c:739  EEXIST
E018  module/zfs/dsl_crypt.c:742  avl_insert
E018  module/zfs/dsl_crypt.c:851  zvol_create_minors
E019  module/zfs/zfs_ioctl.c:7828  spa_keystore_unload_wkey
E020  module/zfs/dsl_crypt.c:919  txg_wait_synced
E020  module/zfs/dsl_crypt.c:940  spa_keystore_unload_wkey_impl
E020  module/zfs/dsl_crypt.c:882  EACCES
E020  module/zfs/dsl_crypt.c:885  EBUSY
E020  module/zfs/dsl_crypt.c:893  dsl_wrapping_key_free
E020  module/zfs/dsl_crypt.c:948  zvol_remove_minors
E021  module/zfs/zfs_ioctl.c:4059  dmu_objset_create
E021  module/zfs/zfs_ioctl.c:7883  spa_keystore_change_key
E021  module/zfs/dmu_objset.c:1359  dmu_objset_create_check
E021  module/zfs/dsl_crypt.c:1778  dsl_sync_task
E021  module/zfs/dsl_synctask.c:64  dst_checkfunc
E022  module/zfs/spa.c:11208  dsl_pool_sync
E022  module/zfs/dsl_pool.c:876  dsl_sync_task_sync
E022  module/zfs/dsl_synctask.c:244  dst_checkfunc
E022  module/zfs/dmu_objset.c:1204  dmu_objset_create_crypt_check
E022  module/zfs/dsl_synctask.c:246  dst_syncfunc
E022  module/zfs/dmu_objset.c:1257  dsl_dataset_create_sync
E022  module/zfs/dsl_dataset.c:1291  dsl_dataset_create_crypt_sync
E023  module/zfs/dsl_crypt.c:1998  dmu_objset_check_wkey_loaded
E023  module/zfs/dsl_crypt.c:2088  spa_keystore_wkey_hold_dd
E024  module/zfs/dsl_crypt.c:2097  wkey
E025  module/zfs/dsl_crypt.c:2097  dsl_crypto_key_create_sync
E025  module/zfs/dsl_crypt.c:2054  dsl_crypto_key_clone_sync
E026  module/zfs/dsl_crypt.c:2761  zio_crypt_key_init
E026  module/zfs/dsl_crypt.c:2763  dsl_crypto_key_sync
E027  module/zfs/dsl_crypt.c:1234  zio_crypt_key_wrap
E027  module/zfs/zio_crypt.c:355  random_get_pseudo_bytes
E027  module/zfs/dsl_crypt.c:1238  dsl_crypto_key_sync_impl
E028  module/zfs/dsl_crypt.c:2112  spa_keystore_load_wkey_impl
E029  lib/libzfs/libzfs_mount.c:535  do_mount
E029  module/os/linux/zfs/zfs_vfsops.c:1456  zfsvfs_create
E029  module/os/linux/zfs/zfs_vfsops.c:651  dmu_objset_own
E030  module/zfs/dmu_objset.c:819  dsl_dataset_own
E030  module/zfs/dsl_dataset.c:877  dsl_dataset_hold_obj_flags
E030  module/zfs/dsl_dataset.c:804  dsl_dataset_create_key_mapping
E030  module/zfs/dsl_dataset.c:787  spa_keystore_create_mapping
E031  module/zfs/dsl_crypt.c:1022  spa_keystore_dsl_key_hold_dd
E031  module/zfs/dsl_crypt.c:668  spa_keystore_dsl_key_hold_impl
E032  module/zfs/dsl_crypt.c:676  spa_keystore_wkey_hold_dd
E032  module/zfs/dsl_crypt.c:432  dsl_dir_get_encryption_root_ddobj
E032  module/zfs/dsl_crypt.c:679  EACCES
E033  module/zfs/dsl_crypt.c:683  dsl_crypto_key_open
E033  module/zfs/dsl_crypt.c:598  zio_crypt_key_unwrap
E034  module/zfs/zio_crypt.c:450  random_get_bytes
E034  module/zfs/zio_crypt.c:455  hkdf_sha512
E034  module/zfs/dsl_crypt.c:607  dsl_wrapping_key_hold
E034  module/zfs/dsl_crypt.c:700  avl_insert
E035  module/zfs/dsl_crypt.c:1052  avl_insert
E036  module/zfs/dmu_objset.c:790  arc_untransform
E036  module/zfs/arc.c:2238  arc_buf_fill
E037  module/zfs/arc.c:2073  arc_fill_hdr_crypt
E037  module/zfs/arc.c:1970  arc_hdr_authenticate
E037  module/zfs/arc.c:1863  spa_do_crypt_objset_mac_abd
E037  module/zfs/arc.c:1866  spa_do_crypt_mac_abd
E038  module/zfs/dsl_crypt.c:2995  spa_keystore_lookup_key
E038  module/zfs/dsl_crypt.c:2888  spa_keystore_lookup_key
E038  module/zfs/dsl_crypt.c:2948  spa_keystore_lookup_key
E038  module/zfs/dsl_crypt.c:2997  EACCES
E039  module/zfs/dsl_crypt.c:1131  dck_holds
E039  module/zfs/dsl_crypt.c:1136  km_key
E040  module/zfs/dsl_crypt.c:2896  zio_crypt_do_objset_hmacs
E041  module/zfs/dsl_crypt.c:2954  zio_crypt_do_hmac
E042  module/zfs/dsl_crypt.c:2915  ECKSUM
E042  module/zfs/dsl_crypt.c:2971  ECKSUM
E043  module/zfs/arc.c:1871  ARC_FLAG_NOAUTH
E043  module/zfs/arc.c:1872  EACCES
E044  module/zfs/dbuf.c:5515  dmu_write_policy
E044  module/zfs/dmu.c:2755  zp_encrypt
E044  module/zfs/dbuf.c:5600  arc_write
E044  include/sys/zio_impl.h:127  ZIO_STAGE_ENCRYPT
E045  module/zfs/zio.c:5684  spa_do_crypt_abd
E046  module/zfs/zio.c:5649  spa_do_crypt_mac_abd
E047  module/zfs/zio.c:5641  spa_do_crypt_objset_mac_abd
E048  module/zfs/zio.c:5626  zio_crypt_do_indirect_mac_checksum_abd
E049  module/zfs/dsl_crypt.c:3019  zio_crypt_key_get_salt
E049  module/zfs/zio_crypt.c:334  zio_crypt_key_change_salt
E049  module/zfs/dsl_crypt.c:3023  zio_crypt_generate_iv
E049  module/zfs/dsl_crypt.c:3027  zio_crypt_generate_iv_salt_dedup
E050  module/zfs/dsl_crypt.c:3034  zio_do_crypt_data
E050  module/zfs/zio_crypt.c:1539  zk_salt
E051  module/zfs/dsl_crypt.c:3034  zio_do_crypt_data
E051  module/zfs/zio_crypt.c:1546  hkdf_sha512
E052  module/zfs/zio_crypt.c:1598  zio_encrypt_os
E052  module/zfs/zio_crypt.c:1601  zio_decrypt_os
E053  module/zfs/zio.c:5626  zio_crypt_do_indirect_mac_checksum_abd
E054  module/zfs/zio.c:5705  zio_push_transform
E055  module/zfs/zio.c:5698  zio_crypt_encode_params_bp
E055  module/zfs/zio.c:5699  zio_crypt_encode_mac_bp
E055  module/zfs/zio.c:5629  zio_crypt_encode_mac_bp
E055  module/zfs/zio.c:5651  zio_crypt_encode_mac_bp
E055  module/zfs/zio.c:5619  zio_crypt_encode_params_bp
E055  module/zfs/zio.c:5601  zio_crypt_encode_mac_bp
E056  module/zfs/dbuf.c:1707  arc_read
E057  module/zfs/arc.c:6472  zio_read
E058  module/zfs/zio.c:1884  zio_decrypt
E058  module/zfs/zio.c:6148  zio_pop_transforms
E059  module/zfs/zio.c:653  zio_crypt_decode_params_bp
E059  module/zfs/zio.c:660  zio_crypt_decode_mac_bp
E059  module/zfs/zio.c:657  zio_crypt_decode_mac_zil
E060  module/zfs/zio.c:663  spa_do_crypt_abd
E061  module/zfs/zio.c:685  EIO
E061  module/zfs/zio.c:689  FM_EREPORT_ZFS_AUTHENTICATION
E062  module/zfs/zio.c:6439  io_done
E062  module/zfs/arc.c:5611  arc_read_done
E062  module/zfs/arc.c:5709  arc_buf_alloc_impl
E063  module/zfs/arc.c:6073  arc_buf_alloc_impl
E063  module/zfs/arc.c:2867  arc_buf_fill
E063  module/zfs/arc.c:2073  arc_fill_hdr_crypt
E064  module/zfs/arc.c:1979  arc_hdr_decrypt
E064  module/zfs/arc.c:1900  spa_do_crypt_abd
E065  module/zfs/arc.c:2080  ARC_FLAG_IO_ERROR
E066  module/zfs/dbuf.c:1366  dbuf_read_done
E067  module/zfs/dsl_pool.c:876  dsl_sync_task_sync
E067  module/zfs/dsl_crypt.c:1778  spa_keystore_change_key_check
E067  module/zfs/dsl_crypt.c:1779  spa_keystore_change_key_sync
E068  module/zfs/dsl_crypt.c:1532  dmu_objset_check_wkey_loaded
E068  module/zfs/dsl_crypt.c:1447  dmu_objset_check_wkey_loaded
E068  module/zfs/dsl_crypt.c:1319  ZFS_ERR_CRYPTO_KEY_MISMATCH
E069  module/zfs/dsl_crypt.c:1710  spa_keystore_wkey_hold_dd
E070  module/zfs/dsl_crypt.c:1609  spa_keystore_dsl_key_hold_dd
E071  module/zfs/dsl_crypt.c:1613  dck_wkey
E071  module/zfs/dsl_crypt.c:1614  dsl_crypto_key_sync
E072  module/zfs/dsl_crypt.c:1742  avl_remove
E072  module/zfs/dsl_crypt.c:1743  dsl_wrapping_key_free
E072  module/zfs/dsl_crypt.c:1748  avl_insert
E073  module/os/linux/zfs/zfs_vfsops.c:1637  dmu_objset_disown
E073  module/zfs/dsl_dataset.c:1027  dsl_dataset_remove_key_mapping
E073  module/zfs/dsl_dataset.c:1018  spa_keystore_remove_mapping
E074  module/zfs/dsl_crypt.c:1004  spa_keystore_dsl_key_rele
E075  module/zfs/dsl_crypt.c:721  dsl_crypto_key_free
E075  module/zfs/dsl_crypt.c:527  dsl_wrapping_key_rele
E076  lib/libzfs/libzfs_mount.c:652  unmount_one
E076  module/os/linux/zfs/zpl_super.c:147  zfs_umount
E077  cmd/zfs/zfs_main.c:4868  flags.raw
E077  module/zfs/dmu_send.c:2849  rawok
E078  module/zfs/dmu_send.c:2625  dsl_crypto_populate_key_nvlist
E078  module/zfs/dsl_crypt.c:2625  DSL_CRYPTO_KEY_MASTER_KEY
E078  module/zfs/dsl_crypt.c:2714  "portable_mac"
E078  module/zfs/dmu_send.c:2632  crypt_keydata
E079  module/zfs/dmu_send.c:1658  ZIO_FLAG_RAW
E079  module/zfs/dmu_send.c:1684  arc_read
E080  module/zfs/dmu_send.c:1685  arc_getbuf_func
E081  module/zfs/dmu_send.c:505  zio_crypt_decode_params_bp
E081  module/zfs/dmu_send.c:507  zio_crypt_decode_mac_bp
E082  module/zfs/dmu_send.c:2644  dump_record
E082  module/zfs/dmu_recv.c:5247  crypt_keydata
E083  module/zfs/dmu_recv.c:5259  dsl_crypto_recv_raw
E083  module/zfs/dsl_crypt.c:2563  dsl_crypto_recv_raw_key_sync
E083  module/zfs/dsl_crypt.c:2404  "prompt"
E083  module/zfs/dsl_crypt.c:2456  rddobj
E083  module/zfs/dsl_crypt.c:2506  dsl_crypto_key_sync_impl
E083  module/zfs/dmu_recv.c:5578  dsl_crypto_recv_raw_key_sync
E084  module/zfs/dmu_recv.c:3888  ZIO_FLAG_RAW
E084  module/zfs/dmu_recv.c:3917  dmu_lightweight_write_by_dnode
E084  module/zfs/zio.c:5596  ZIO_FLAG_RAW_ENCRYPT
E085  cmd/zfs/zfs_main.c:194  zfs_do_create
E086  cmd/zfs/zfs_main.c:234  zfs_do_load_key
E086  cmd/zfs/zfs_main.c:235  zfs_do_unload_key
E087  cmd/zfs/zfs_main.c:218  zfs_do_mount
E087  cmd/zfs/zfs_main.c:219  zfs_do_unmount
E088  cmd/zfs/zfs_main.c:236  zfs_do_change_key
E089  cmd/zfs/zfs_main.c:223  zfs_do_send
```

## Appendix D. Tunable and property source references

Where each tunable and dataset property named in section 8 is declared, at commit `c913da8615`. A tunable's symbol is the name as written in its `ZFS_MODULE_PARAM` line; a property's symbol is its quoted name in the `zprop_register_*()` call in `module/zcommon/zfs_prop.c`.

```
zfs_disable_ivset_guid_check  module/zfs/dsl_crypt.c:3078  disable_ivset_guid_check
zfs_key_max_salt_uses  module/zfs/zio_crypt.c:1677  max_salt_uses
encryption  module/zcommon/zfs_prop.c:565  "encryption"
encryptionroot  module/zcommon/zfs_prop.c:613  "encryptionroot"
keyformat  module/zcommon/zfs_prop.c:560  "keyformat"
keylocation  module/zcommon/zfs_prop.c:616  "keylocation"
keystatus  module/zcommon/zfs_prop.c:546  "keystatus"
pbkdf2iters  module/zcommon/zfs_prop.c:682  "pbkdf2iters"
pbkdf2salt  module/zcommon/zfs_prop.c:770  "pbkdf2salt"
```
