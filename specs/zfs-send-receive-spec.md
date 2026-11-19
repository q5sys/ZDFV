# ZFS send and receive (build spec)

This diagram follows a replication stream from end to end: how `zfs send` turns a snapshot (or the difference between two points in a dataset's history) into a flat stream of records, what those records are, why an incremental stream is small, what -c, -w, -L, -e and -t change, and how `zfs receive` applies the records to a hidden, inconsistent dataset and then switches it into place in a single transaction group.

Source of truth: `https://github.com/openzfs/zfs` at commit `c913da86156eba3243cc1ef515e98d69887654a7` (master, 2026-11-13, version 2.4.99). Every function name, file path and tunable in this document was checked against that commit.

## 0. Instructions to the building agent

Render this spec with the viewer in `../viewer`, as extended by `zfs-viewer-suite-spec.md`. Sections 6 to 10 and the appendices are data: do not change nodes, wires, labels or paths without verifying the change against the pinned commit.

## 1. Goal

One page that lets a ZFS administrator answer "what is in a send stream, why is an incremental small, what do -c / -w / -L / -e / resume / -F actually change, and how does receive turn records back into a dataset atomically?" by following wires between boxes.

### Mental model the diagram has to convey

1. A send stream is a flat sequence of records that describe objects and blocks, not files: BEGIN, then OBJECT, FREEOBJECTS, OBJECT_RANGE, WRITE, WRITE_EMBEDDED, SPILL, FREE and REDACT records in (object, offset) order, then END. Every record header carries a running fletcher-4 checksum of everything before it, and END carries the checksum of the whole stream.
2. An incremental stream is small because of birth txgs. The traversal skips every block pointer born at or before the from point's creation txg, and the whole subtree below it, so unchanged data is never even read. Only the from point's txg and guid are needed, which is why a bookmark (which keeps no blocks) works as an incremental source.
3. Send is a pipeline of kernel threads joined by queues that are limited in bytes: the traversal finds candidate blocks, the merge thread applies redaction, the reader thread starts the reads early (taking a block from the ARC only if it is already cached, otherwise reading it directly without filling the ARC), and the main thread turns each range into records and writes them to the file descriptor.
4. The send flags only change how blocks are represented. -c sends compressed blocks as they are on disk; -w sends the encrypted on-disk bytes with their salt, IV and MAC plus the wrapped keys, so no key is needed; without -L blocks over 128K are split into 128K records; -e sends tiny embedded blocks as the bytes held in the block pointer. Receive writes compressed and raw payloads to disk as they arrive, without recompressing or re-encrypting.
5. Userspace only frames the stream. `zfs receive` reads the BEGIN record and hands the file descriptor to the kernel, which reads every other record itself; on the send side the kernel writes the records straight to the descriptor.
6. Receive writes into a dataset nobody can use yet: a new dataset, or the hidden clone tofs/%recv when the target exists, flagged inconsistent. A writer thread applies the records in ordinary DMU transactions and txg sync writes them like any other dirty data.
7. The switch is atomic: one sync task, in one txg, snapshots the result with the sender's guid, swaps %recv into the target (after destroying newer snapshots when -F is given) and destroys the clone. Until that txg an existing target is untouched, and for an incremental stream it stays mounted and readable throughout.
8. With -s the position of the last applied record is saved in every txg. After an interruption the inconsistent dataset survives, and its receive_resume_token tells `zfs send -t` where to restart.

### Scope

In scope: `zfs send` and `zfs receive` in cmd/zfs, libzfs and libzfs_core; the send and receive ioctls; the kernel send pipeline in dmu_send.c and the traversal it uses; record types and their checksums; incremental sends from snapshots and bookmarks; compressed, raw, large-block and embedded streams; resumable receive and resumed send; receive begin, the writer thread and its record handlers, receive end, -F, raw receive and corrective receive (-c); replication streams (-R) at the userspace level.

Out of scope: building redacted streams (zfs redact, --redact) beyond the redaction-list thread, zfs send -S (saved streams), stream size estimates and progress reporting, property and hold handling, `zfs bookmark` itself, the key management behind raw streams (see the encryption graph) and the write pipeline below dbuf_sync (see the I/O graph).

## 2. Deliverable

Built by `../viewer/build_graph.py --spec specs/zfs-send-receive-spec.md`; the page is `zfs-send-receive.html` in the suite described in `zfs-viewer-suite-spec.md`.

## 6. Wire types and contexts

### 6.1 Wire types

| type id | colour | name | what travels on the wire |
|---|---|---|---|
| `stream` | `#C0EB75` | Send stream records | dmu_replay_record_t headers and their payloads: BEGIN, OBJECT, FREEOBJECTS, OBJECT_RANGE, WRITE, WRITE_EMBEDDED, SPILL, FREE, REDACT, END. |
| `dbuf` | `#FFA94D` | DMU buffer | dmu_buf_impl_t: one logical block of one object, held in memory (plus its dirty records). |
| `arc` | `#B197FC` | ARC buffer | arc_buf_t / arc_buf_hdr_t: cached block, keyed by DVA + birth txg. |
| `abd` | `#FF6B6B` | Physical payload | abd_t: the bytes exactly as they sit on disk (compressed / encrypted / padded to ashift). |
| `zio` | `#4DABF7` | I/O request | zio_t moving through the pipeline (logical zio or a vdev child zio). |
| `bp` | `#F783AC` | Block pointer | blkptr_t: DVAs + sizes + checksum + birth txg; here also send_range entries, which carry a copy of the block pointer. |
| `tx` | `#FFD43B` | Transaction | dmu_tx_t membership / a txg number being opened, quiesced or synced. |
| `ctl` | `#868E96` | Control | Calls that carry no payload: locks, wakeups, throttling, accounting, callbacks. Draw dashed. |

### 6.2 Execution contexts

| ctx id | meaning |
|---|---|
| `user` | Userspace |
| `open` | Open context: the calling thread, inside a dmu_tx |
| `syscall` | Kernel, in the thread of the calling process (an ioctl on /dev/zfs, mount(2) or umount(2)) or a helper thread it starts, outside syncing context and outside any dmu_tx |
| `sync` | Syncing context: txg_sync thread or dp_sync_taskq workers, one txg at a time |
| `thr` | A dedicated kernel thread or zthr |
| `any` | Runs in whichever context calls it |

## 7. Groups and default layout

Flow runs left to right: the sending side on the left, the stream in the middle, the receiving side and the shared DMU and txg machinery on the right.

| group id | title | colour | first column | band | sub-columns | nodes | summary |
|---|---|---|---|---|---|---|---|
| `snd_user` | Sender userspace (zfs send) | `#5C5F66` | 0 | full | 1 | 5 | The zfs command, libzfs and libzfs_core: option parsing, resume tokens, replication packages. |
| `snd_kern` | Send entry (ioctl, dmu_send) | `#2B8A3E` | 1 | full | 1 | 4 | The ioctl, the choice of from point and the BEGIN record. |
| `snd_pipe` | Send thread pipeline | `#D9480F` | 2 | top | 3 | 10 | Traversal, merge and reader threads, then the main thread turning ranges into records. |
| `snd_io` | Block reads (shared with the I/O graph) | `#6741D9` | 2 | bottom | 3 | 2 | Where the sender's reads go: the ARC if the block is cached, otherwise a direct zio. |
| `stream` | Stream and resume token | `#0C8599` | 5 | full | 1 | 2 | The bytes between the two machines, and the token that restarts an interrupted transfer. |
| `rcv_user` | Receiver userspace (zfs receive) | `#495057` | 6 | full | 1 | 4 | Reads the BEGIN record, checks the destination, hands the file descriptor to the kernel. |
| `rcv_kern` | Receive entry, begin and end | `#C2255C` | 7 | full | 2 | 9 | The ioctl and the sync tasks that create the receiving dataset and later switch it into place. |
| `rcv_pipe` | Receive threads and record handlers | `#1971C2` | 9 | full | 2 | 10 | The reader in the ioctl thread, the writer thread and one handler per record type. |
| `dmu` | DMU and txg (shared with the I/O graph) | `#E67700` | 11 | full | 2 | 11 | Transactions, dirty records and the txg sync that finally writes the received data. |

Default layout rules:

- Column pitch is 400 px. A group starts at `first column * 400` and is `sub-columns` columns wide. A node's x is `(group first column + node sub-col) * 400`.
- Inside a sub-column, stack nodes top to bottom in the order they appear in the section 8 tables, 28 px apart. Node height follows its socket count.
- Band `full` groups start at the top. Groups `snd_pipe` (band `top`) and `snd_io` (band `bottom`) share columns 2 to 4: place `snd_io` 90 px below the bottom of `snd_pipe`.
- The layout must be deterministic. Do not run a force-directed or randomised layout in the page.
- Check the default at "fit all": group titles must be readable and no node may overlap another.

## 8. Nodes

57 nodes. `sub-col` is the node's column inside its group. `functions` are real symbols at the pinned commit (locations in Appendix A); the first one is the node's headline function. Nodes whose id also appears in the I/O graph start their role with "Shared with the I/O flow graph."

### 8.1 Sender userspace (zfs send) (`snd_user`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `admin` | Administrator | 0 | `user` | - | - | The person or script typing the command. Every path in this graph that a command starts begins with a wire from this node; the arrows that come back into a command node are its results, errors and refusals. |
| `zfs_send_cmd` | zfs send (cmd/zfs) | 0 | `user` | `cmd/zfs/zfs_main.c` | `zfs_do_send` | Parses the send options: -i / -I name the incremental source (a snapshot with @ or a bookmark with #), -R asks for a replication stream, -c compressed, -w raw (which also sets -c, -e and -L), -L large blocks, -e embedded blocks, -t a resume token. Without -R or -I the send goes through zfs_send_one(); -R and -I go through zfs_send(); -t goes to zfs_send_resume(). -D is accepted but only prints that deduplicated streams are no longer supported. |
| `libzfs_send` | libzfs: zfs_send_one() / zfs_send_resume() | 0 | `user` | `lib/libzfs/libzfs_sendrecv.c` | `zfs_send_one`, `zfs_send_one_cb_impl`, `lzc_flags_from_sendflags`, `zfs_send_resume`, `zfs_send_resume_impl_cb_impl`, `zfs_send_resume_token_to_nvlist` | Turns the command flags into lzc_send_flags, runs the optional size estimate and progress thread, then calls libzfs_core. For -t it decodes the token (hex, checked with fletcher-4, zlib-uncompressed into an nvlist), finds the snapshot by the token's toguid, and takes the resume object, offset and the -L / -c / -e / -w flags from the token. |
| `libzfs_repl` | libzfs: replication stream (-R, -I) | 0 | `user` | `lib/libzfs/libzfs_sendrecv.c` | `zfs_send`, `zfs_send_cb_impl`, `send_prelim_records`, `dump_filesystems`, `dump_snapshot`, `dump_ioctl`, `send_conclusion_record` | Builds a compound stream in userspace: a BEGIN record marked DMU_COMPOUNDSTREAM (with -R its payload lists every filesystem, snapshot and property) closed by its own END, then one ordinary substream per snapshot, each requested from the kernel with the legacy ZFS_IOC_SEND and incremental from the previous snapshot, then a final END. The kernel only ever produces single-snapshot streams. |
| `lzc_send` | libzfs_core: lzc_send_resume_redacted() | 0 | `user` | `lib/libzfs_core/libzfs_core.c` | `lzc_send_resume_redacted`, `lzc_send_redacted`, `lzc_send_resume_redacted_cb_impl`, `lzc_send_wrapper` | Packs the arguments into an nvlist (fd, fromsnap, largeblockok, embedok, compressok, rawok, savedok, resume_object, resume_offset, redactbook) and issues ZFS_IOC_SEND_NEW. On Linux, lzc_send_wrapper() puts a pipe and a copying thread in front of an output that is not already a pipe. |

### 8.2 Send entry (ioctl, dmu_send) (`snd_kern`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `ioc_send` | Send ioctl | 0 | `syscall` | `module/zfs/zfs_ioctl.c` | `zfs_ioc_send_new`, `zfs_ioc_send`, `dump_bytes_init`, `dump_bytes` | Kernel entry. Sets the stream output function to dump_bytes(), which writes every header and payload to the caller's file descriptor with zfs_file_write() (through a one-thread z_send taskq where kernel stacks are small), then calls dmu_send(). The legacy zfs_ioc_send(), still used by replication streams, calls dmu_send_obj() with dataset object numbers instead of names. |
| `dmu_send` | dmu_send() / dmu_send_obj() | 0 | `syscall` | `module/zfs/dmu_send.c` | `dmu_send`, `dmu_send_obj` | Holds the pool and the snapshot to send (owning the dataset instead when a filesystem itself is sent). A non-raw send holds it with DS_HOLD_FLAG_DECRYPT, so an encrypted dataset needs its key loaded; a raw send does not. Resolves the incremental source, marks the stream as a clone stream when the source is in another filesystem, then calls dmu_send_impl(). |
| `send_from` | Incremental source: snapshot or bookmark | 0 | `syscall` | `module/zfs/dmu_send.c` | `dsl_dataset_is_before`, `dsl_bookmark_lookup` | Reduces the from point to a zfs_bookmark_phys_t: creation txg, guid and IV set guid. A snapshot must be an earlier snapshot of the same lineage (dsl_dataset_is_before(), otherwise EXDEV); a bookmark is checked the same way by dsl_bookmark_lookup(). Nothing else about the from point is used, so a bookmark, which keeps no blocks, is as good a source as the snapshot it was made from. |
| `send_setup` | dmu_send_impl(): BEGIN, threads, END | 0 | `syscall` | `module/zfs/dmu_send.c` | `dmu_send_impl`, `setup_featureflags`, `create_begin_record`, `setup_resume_points`, `setup_to_thread`, `setup_from_thread`, `setup_redact_list_thread`, `setup_merge_thread`, `setup_reader_thread` | Chooses the stream's feature flags from the request and from what the dataset uses (LARGE_BLOCKS with -L or -w if large blocks are active, EMBED_DATA with -e unless the dataset is encrypted, COMPRESSED with -c or -w, RAW with -w on an encrypted dataset, LZ4, ZSTD, LARGE_DNODE, RESUMING, REDACTED). Writes BEGIN with an optional nvlist payload, starts the worker threads, then runs the main loop: take a range from the reader queue, do_dump() it, stop on a signal. Ends with END, or with no END at all for a saved send. |

### 8.3 Send thread pipeline (`snd_pipe`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `send_traverse` | to_ds traversal thread | 0 | `thr` | `module/zfs/dmu_send.c` | `send_traverse_thread`, `send_cb` | Walks the snapshot being sent with traverse_dataset_resume() and turns every block pointer it is handed into a send_range: OBJECT for a dnode (with a copy of the dnode), OBJECT_RANGE for a meta-dnode data block, DATA for a level-0 block (with a copy of its block pointer), HOLE for a hole, REDACT for a redacted block. Queues them in order and finishes with an end-of-stream marker. The queues between the worker threads are limited in bytes. Tunables: `zfs_send_no_prefetch_queue_length`, `zfs_send_no_prefetch_queue_ff`. |
| `traverse` | traverse_visitbp(): birth-txg pruning | 0 | `thr` | `module/zfs/dmu_traverse.c` | `traverse_visitbp`, `traverse_dataset_resume`, `traverse_impl`, `traverse_prefetch_metadata`, `resume_skip_check` | Pre-order walk of the block tree. A block pointer whose birth txg is at or before fromtxg is skipped together with everything below it: copy-on-write rewrites every indirect block above a changed block in the same txg, so an old parent proves the whole subtree is unchanged. A raw send of an encrypted dataset compares the physical birth (zfs rewrite -P keeps the logical one); other sends compare the logical birth. Holes carry a birth txg too, so deleted data is found the same way; holes with birth 0 (written before the hole_birth feature) are always visited while send_holes_without_birth_time is 1, its default. Indirect blocks are read through the ARC, with read-ahead of the next few. On a resumed send, resume_skip_check() skips everything before the resume point. Tunables: `zfs_traverse_indirect_prefetch_limit`, `send_holes_without_birth_time`. |
| `redact_list` | Redaction-list threads | 0 | `thr` | `module/zfs/dmu_send.c` | `redact_list_thread`, `redact_list_cb` | Two optional inputs to the merge. The from thread always runs: when the source is a redaction bookmark it lists the blocks that the earlier stream left out (so they can be sent now), otherwise it only queues an end-of-stream marker. The redact thread runs only for a redacted send and lists the blocks to leave out. |
| `send_merge` | send_merge_thread() | 1 | `thr` | `module/zfs/dmu_send.c` | `send_merge_thread`, `find_next_range` | Merges the traversal, from and redact queues in (object, block) order. A block that appears in a redaction list is turned into a REDACT range; one already redacted on both sides is dropped. Without redaction it passes the traversal's ranges through unchanged. |
| `send_reader` | send_reader_thread() | 1 | `thr` | `module/zfs/dmu_send.c` | `send_reader_thread`, `issue_data_read`, `dmu_send_read_done`, `piggyback_unmodified_spill` | Starts the read of each DATA range as soon as it is known, so the main thread rarely waits. It asks the ARC with ARC_FLAG_CACHED_ONLY and, if the block is not cached, reads it with a direct zio_read() into a private buffer, so a large send does not push other data out of the ARC. With -c it asks for compressed data (ZIO_FLAG_RAW_COMPRESS), except for metadata, embedded blocks, blocks needing a byteswap or blocks split for lack of -L; with -w it asks for the raw on-disk bytes (ZIO_FLAG_RAW). Its output queue is limited by the bytes of data in flight. Tunables: `zfs_send_queue_length`, `zfs_send_queue_ff`. |
| `do_dump` | do_dump(): range to record | 1 | `syscall` | `module/zfs/dmu_send.c` | `do_dump`, `send_do_embed` | Runs in the ioctl thread. Picks the record for each range and, for DATA, waits for its read. A read error fails the send with EIO, unless zfs_send_corrupt_data is set, in which case the block is sent filled with the pattern 0x2f5baddb10c. A block larger than 128K without -L is cut into 128K WRITE records; an embedded block pointer with -e becomes WRITE_EMBEDDED; OBJECT_RANGE ranges are dropped unless the send is raw. Tunables: `zfs_send_corrupt_data`. |
| `dump_obj` | Object records (OBJECT, FREEOBJECTS, OBJECT_RANGE) | 2 | `syscall` | `module/zfs/dmu_send.c` | `dump_dnode`, `dump_freeobjects`, `dump_object_range` | OBJECT carries the dnode's type, block size, bonus type and the bonus buffer (block size clamped to 128K without -L). A raw OBJECT also carries nlevels, maxblkid and the whole encrypted bonus area. Unallocated object numbers become FREEOBJECTS records, merged when adjacent. OBJECT_RANGE (raw only) carries the salt, IV and MAC of one block of dnodes. On a resumed send, objects before the resume object are not sent again. |
| `dump_data` | Data records (WRITE, WRITE_EMBEDDED, SPILL) | 2 | `syscall` | `module/zfs/dmu_send.c` | `dmu_dump_write`, `dump_write_embedded`, `dump_spill` | WRITE carries object, offset, logical size and the block. For a compressed or raw block it also carries the compression type and compressed size, and for raw the salt, IV, MAC and byteswap flag. When a block pointer is available (not for split, embedded or decrypted blocks) the record also carries its checksum, flagged when that checksum is strong enough for dedup. WRITE_EMBEDDED carries the few bytes decoded from an embedded block pointer. SPILL carries an object's spill block; unmodified spill blocks are also sent, flagged, so old receivers do not drop them. Tunables: `zfs_send_unmodified_spill_blocks`. |
| `dump_free` | FREE and REDACT records | 2 | `syscall` | `module/zfs/dmu_send.c` | `dump_free`, `dump_redact` | FREE tells the receiver that a byte range of an object holds no data: holes found by the traversal, and the region past the end of every object sent. Adjacent frees are merged into one pending record. Frees are sent in full streams too (DRR_FLAG_FREERECORDS), so that a full stream can be received as a clone. REDACT marks ranges left out of a redacted stream. |
| `dump_record` | dump_record(): checksum and output | 2 | `syscall` | `module/zfs/dmu_send.c` | `dump_record` | Adds the record header to the running fletcher-4 checksum, stores that checksum in the header (every record except BEGIN), adds the payload, and writes header and payload through the stream's output function. The checksum always covers everything before the field it is stored in, so END's checksum covers the whole stream. |

### 8.4 Block reads (shared with the I/O graph) (`snd_io`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `arc_read` | arc_read() | 0 | `any` | `module/zfs/arc.c` | `arc_read`, `arc_getbuf_func` | Shared with the I/O flow graph. Serves the traversal's indirect and dnode blocks, the sender's ARC_FLAG_CACHED_ONLY lookups (a hit hands back a buffer, a miss returns an error instead of reading), the receive prefetches and the corrective receive's check read. |
| `zio_create` | zio create + execute | 1 | `any` | `module/zfs/zio.c` | `zio_read`, `zio_write`, `zio_rewrite`, `zio_nowait`, `zio_wait` | Shared with the I/O flow graph. The sender's direct reads of uncached blocks, the receiver's writes at txg sync, and the corrective receive's in-place rewrite and verification read enter the zio pipeline here. |

### 8.5 Stream and resume token (`stream`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `stream_fd` | Stream bytes (pipe, file, ssh) | 0 | `user` | - | - | Whatever carries the bytes from `zfs send` to `zfs receive`: a pipe, a file, ssh or a network tool. ZFS adds no framing beyond the records themselves, each a fixed-size dmu_replay_record_t header followed by its payload. |
| `resume_token` | receive_resume_token | 0 | `syscall` | `module/zfs/dsl_dataset.c` | `get_receive_resume_token`, `get_receive_resume_token_impl` | Read-only property of a dataset whose resumable receive was interrupted. Built on demand from the DS_FIELD_RESUME_* entries of the dataset or of its tofs/%recv child: fromguid, object, offset, bytes, toguid, toname and the -L / -e / -c / -w flags of the original stream, packed as an nvlist, gzip-compressed, checksummed with fletcher-4 and hex-encoded. Properties: `receive_resume_token`. |

### 8.6 Receiver userspace (zfs receive) (`rcv_user`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `zfs_recv_cmd` | zfs receive (cmd/zfs) | 0 | `user` | `cmd/zfs/zfs_main.c` | `zfs_do_receive` | Parses the receive options: -F force, -s resumable, -A abort (destroys the saved resumable state), -c heal an existing snapshot, -o / -x property overrides, -d / -e name mapping, -u no mount. Refuses to read the stream from a terminal. |
| `libzfs_recv` | libzfs: zfs_receive() / zfs_receive_one() | 0 | `user` | `lib/libzfs/libzfs_sendrecv.c` | `zfs_receive`, `zfs_receive_impl`, `zfs_receive_one` | Reads and checks the BEGIN record (magic, byte order, stream type). A compound stream goes to the package code. A single stream goes to zfs_receive_one(), which works out the destination name and enforces the userspace rules: a full stream into an existing dataset needs -F and a dataset without snapshots, -F may not destroy an encrypted dataset, and an existing filesystem that a full stream replaces is unmounted first. Then it passes the BEGIN record and the file descriptor to libzfs_core. |
| `libzfs_recv_pkg` | libzfs: replication receive | 0 | `user` | `lib/libzfs/libzfs_sendrecv.c` | `zfs_receive_package`, `recv_incremental_replication`, `recv_destroy` | For a compound stream: reads the list of filesystems and snapshots, renames and promotes to match the sender, and with -F destroys snapshots and filesystems that are not in the stream. Then receives each substream in turn through zfs_receive_impl(). |
| `lzc_recv` | libzfs_core: recv_impl() | 0 | `user` | `lib/libzfs_core/libzfs_core.c` | `recv_impl`, `lzc_receive_with_cmdprops`, `lzc_receive_with_heal` | Issues the receive ioctl. Resumable, healing and raw receives, and streams with a BEGIN payload, use ZFS_IOC_RECV_NEW with an nvlist (snapname, begin_record, input_fd, force, resumable, heal, properties); anything else uses the legacy ZFS_IOC_RECV. The stream itself is never copied through userspace. |

### 8.7 Receive entry, begin and end (`rcv_kern`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `ioc_recv` | Receive ioctl | 0 | `syscall` | `module/zfs/zfs_ioctl.c` | `zfs_ioc_recv_impl`, `zfs_ioc_recv_new`, `zfs_ioc_recv` | Kernel entry and the order of the whole receive: dmu_recv_begin(), set received and -o / -x properties, dmu_recv_stream(), then for a mounted target suspend the filesystem (or zvol), dmu_recv_end(), and resume it on the new contents. A mounted target stays usable while the stream is applied; it is only suspended for the switch. |
| `recv_begin` | dmu_recv_begin() | 0 | `syscall` | `module/zfs/dmu_recv.c` | `dmu_recv_begin` | Checks the BEGIN magic (byteswapped streams are accepted and swapped), starts the stream checksum with the BEGIN record, reads and unpacks the BEGIN payload, and runs the begin sync task: the resume variant when the stream has the RESUMING feature flag. For a full, non-raw receive it also turns -o encryption properties into crypto parameters for the new dataset. |
| `recv_end` | dmu_recv_end() | 0 | `syscall` | `module/zfs/dmu_recv.c` | `dmu_recv_end`, `dmu_recv_new_end`, `dmu_recv_existing_end` | Runs the end sync task, the new-dataset or the existing-dataset variant. On failure cleans up as for an interrupted stream. On success creates zvol device nodes for a new volume and its snapshot. |
| `recv_cleanup` | dmu_recv_cleanup_ds(): failed receive | 0 | `syscall` | `module/zfs/dmu_recv.c` | `dmu_recv_cleanup_ds` | Runs when the stream or the end task fails. Waits for the current txg to sync so the last saved resume state is on disk, then either keeps the inconsistent dataset (resumable receive that got past its first records) or destroys it (the new dataset or tofs/%recv). A corrective receive never destroys its snapshot. |
| `sync_task` | dsl_sync_task() | 1 | `syscall` | `module/zfs/dsl_synctask.c` | `dsl_sync_task`, `dsl_sync_task_common`, `dsl_sync_task_sync` | The mechanism for changing the pool's dataset structure. The caller runs the check function in open context, queues the check and sync pair on the open txg and waits for that txg to sync; dsl_pool_sync() then runs the check again and the sync function in syncing context. Everything a sync function changes lands on disk in that one txg. |
| `recv_begin_sync` | Begin check and sync | 1 | `sync` | `module/zfs/dmu_recv.c` | `dmu_recv_begin_check`, `recv_begin_check_existing_impl`, `dmu_recv_begin_sync`, `dmu_recv_resume_begin_check`, `dmu_recv_resume_begin_sync` | Decides where the stream goes. Target missing: the stream must be full or a clone stream, and the dataset is created under its final name. Target present: no tofs/%recv and no resume state may exist, the new snapshot name must be free, and for an incremental stream a snapshot with the stream's fromguid must exist; without -F the target must be unmodified since its latest snapshot, which must be that one (ETXTBSY otherwise), and with -F an older snapshot is accepted. A full stream onto an existing dataset needs -F and is refused for encrypted datasets. Raw streams need the encryption feature and no embedded data. |
| `recv_end_sync` | End check and sync (the switch) | 1 | `sync` | `module/zfs/dmu_recv.c` | `dmu_recv_end_check`, `dmu_recv_end_sync`, `dsl_dataset_clone_swap_sync_impl`, `dsl_dataset_snapshot_sync_impl`, `dsl_destroy_snapshot_sync_impl`, `dsl_destroy_head_sync_impl` | The atomic switch, in one txg. Existing target: with -F, destroy every snapshot newer than the from snapshot; swap the contents of tofs/%recv into tofs (discarding any changes made to tofs since that snapshot); snapshot tosnap; destroy %recv. New dataset: snapshot tosnap. Either way the new snapshot gets the sender's guid (drr_toguid), so a later incremental stream finds it, and the inconsistent flags and resume entries are cleared. A corrective receive changes nothing here. |
| `recv_ds` | Receiving dataset (new or tofs/%recv) | 1 | `any` | `module/zfs/dsl_dataset.c` | `dsl_dataset_create_sync`, `dsl_dataset_has_resume_receive_state` | The dataset the records are written into: a new dataset under its final name, the hidden clone tofs/%recv of the from snapshot when the target exists, or for -c the existing snapshot itself. It is owned by the receive and flagged DS_FLAG_INCONSISTENT, so it cannot be mounted or sent normally until the end sync task. With -s it holds the DS_FIELD_RESUME_* entries (toguid, toname, fromguid, object, offset, bytes and the stream flags) that make up the resume token. |
| `recv_crypt` | Raw receive keys | 1 | `any` | `module/zfs/dsl_crypt.c` | `dsl_crypto_recv_raw`, `dsl_crypto_recv_raw_objset_sync`, `dsl_crypto_recv_raw_key_sync` | A raw stream carries the dataset's wrapped master and HMAC keys, key format and PBKDF2 parameters and the meta-dnode layout in the BEGIN nvlist (crypt_keydata). They are written as they are, never unwrapped, so the receiving system needs no key. A new dataset gets them at once in their own sync task; for an existing dataset only the objset is set up then and the key is installed in the end sync task. |

### 8.8 Receive threads and record handlers (`rcv_pipe`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `recv_stream` | dmu_recv_stream(): reader | 0 | `syscall` | `module/zfs/dmu_recv.c` | `dmu_recv_stream`, `receive_read_record`, `receive_read_prefetch`, `resume_check` | Runs in the ioctl thread. Installs the raw keys, checks a resumed stream's start point, starts the writer thread, then reads records one by one, validates each header (recv_check_drr_*), reads its payload, prefetches the indirect blocks that WRITE records will need, and queues the record for the writer. Stops at END, on an error or on a signal, then waits for the writer. A full stream received as a clone also frees every object above the highest one the stream mentioned. |
| `recv_cksum` | Record read and checksum check | 0 | `syscall` | `module/zfs/dmu_recv.c` | `receive_read_payload_and_next_header`, `receive_read`, `receive_cksum` | Reads straight from the stream's file descriptor with zfs_file_read(). The running fletcher-4 checksum over everything read so far must equal the checksum in each new header (headers with a zero checksum are not checked), and END must carry the checksum of the whole stream. A mismatch fails the receive with ECKSUM; an early end of the stream gives ZFS_ERR_STREAM_TRUNCATED. Both leave resumable state behind when -s was given. |
| `recv_writer` | receive_writer_thread() | 0 | `thr` | `module/zfs/dmu_recv.c` | `receive_writer_thread`, `receive_process_record` | Takes records off the queue in stream order and hands each to its handler. Any record other than WRITE first flushes the pending batch of WRITE records. After an error it keeps draining and freeing records until the end-of-stream marker. At the end it replays any deferred records, flushes the last batch and wakes the reader. Tunables: `zfs_recv_queue_length`, `zfs_recv_queue_ff`. |
| `recv_resume_state` | save_resume_state() | 0 | `thr` | `module/zfs/dmu_recv.c` | `save_resume_state` | With -s, records the object and offset of the last OBJECT, WRITE or WRITE_EMBEDDED record applied in a tx, and the stream bytes read so far, in the dataset's in-memory slot for that tx's txg. dsl_dataset_sync() writes the slot to the dataset's ZAP when the txg syncs, so the resume point on disk always matches data that is on disk. While records are deferred the point is held at the first deferred record. |
| `recv_object` | receive_object() | 1 | `thr` | `module/zfs/dmu_recv.c` | `receive_object`, `receive_handle_existing_object`, `receive_defer_park`, `receive_defer_flush` | Applies OBJECT: claims a free object number with the stream's type, block size, bonus and dnode size, or reclaims an existing object whose type, block size or bonus changed (freeing its old contents first), sets checksum and compression, copies in the bonus buffer, and for raw streams sets the dnode layout and the dnode block's encryption parameters. When an object number must be reused at a different dnode size, the old dnode's free has to sync first; instead of a txg wait per object the claim and every later record touching those slots are parked and replayed after one txg wait (not for raw or corrective receives). Tunables: `zfs_recv_defer_batch_size`. |
| `recv_freeobjects` | receive_freeobjects() / receive_free() | 1 | `thr` | `module/zfs/dmu_recv.c` | `receive_freeobjects`, `receive_free`, `receive_redact`, `receive_defer_free_object` | FREEOBJECTS frees every allocated object in its range (skipping the inner slots of large dnodes). FREE frees a byte range of an object with dmu_free_long_range(), which works in chunks of separate transactions. REDACT is applied as a FREE. |
| `recv_write` | WRITE batch: lightweight writes | 1 | `thr` | `module/zfs/dmu_recv.c` | `receive_process_write_record`, `flush_write_batch`, `flush_write_batch_impl` | Collects consecutive WRITE records of one object (they must arrive in increasing object, offset order) and applies the batch in a single tx. A record that matches the object's block size is written as a lightweight write: the record's buffer becomes the block, with no dbuf and no ARC copy, which is safe because nothing can read the dataset before the receive ends. A compressed record is written still compressed and a raw record still encrypted, with the record's salt, IV and MAC. A record of another size is decompressed if needed and written with dmu_write_by_dnode(). Tunables: `zfs_recv_write_batch_size`. |
| `recv_embedded` | receive_write_embedded() / receive_spill() | 1 | `thr` | `module/zfs/dmu_recv.c` | `receive_write_embedded`, `receive_spill` | WRITE_EMBEDDED puts the record's bytes back into a block pointer (or, if the record does not match the object's block size, decompresses it and writes it normally). SPILL replaces the object's spill block with a loaned ARC buffer, a raw one for raw streams; unmodified spill records are ignored by receivers that know the spill-block flag. |
| `recv_objrange` | receive_object_range() (raw) | 1 | `thr` | `module/zfs/dmu_recv.c` | `receive_object_range` | Raw streams only: keeps the salt, IV, MAC and byte order of one block of dnodes until the next OBJECT record in that block applies them, so the received dnode block gets the same encryption parameters as on the sender. |
| `recv_heal` | Corrective receive (zfs receive -c) | 1 | `thr` | `module/zfs/dmu_recv.c` | `do_corrective_recv`, `corrective_read_done` | Uses only WRITE records, against an existing snapshot. Reads the block; only a checksum error (ECKSUM) makes it a candidate. Recompresses (and for an encrypted dataset re-encrypts with the block's own salt and IV) the record's data into the block's on-disk form, recomputes the checksum and requires it to equal the block pointer's, then rewrites the same disk locations and reads the block back; on success the block leaves the pool's error log. A block that cannot be reproduced fails the receive unless zfs_recv_best_effort_corrective is set. Tunables: `zfs_recv_best_effort_corrective`. |

### 8.9 DMU and txg (shared with the I/O graph) (`dmu`)

| node id | title | sub-col | ctx | primary source file | functions | role |
|---|---|---|---|---|---|---|
| `dmu_tx` | dmu_tx (transaction) | 0 | `open` | `module/zfs/dmu_tx.c` | `dmu_tx_create`, `dmu_tx_hold_write_by_dnode`, `dmu_tx_assign`, `dmu_tx_commit` | Shared with the I/O flow graph. Every receive handler declares what it will change and joins the open txg like any writer, so receive is subject to the same write throttle. |
| `dmu_object` | dmu_object claim / reclaim / free | 0 | `open` | `module/zfs/dmu_object.c` | `dmu_object_claim_dnsize`, `dmu_object_reclaim_dnsize`, `dmu_object_free` | Object allocation at a number chosen by the caller, as receive needs: claim a free number, reallocate an existing object with new properties, or free one. |
| `dmu_free` | dmu_free_long_range() | 0 | `open` | `module/zfs/dmu.c` | `dmu_free_long_range`, `dmu_free_long_range_impl` | Frees a byte range of an object in chunks, each in its own transaction, waiting for the next txg when too many frees are dirty, so that a large free does not build one huge txg. |
| `dmu_write` | dmu_write family | 0 | `open` | `module/zfs/dmu.c` | `dmu_lightweight_write_by_dnode`, `dmu_write_by_dnode`, `dmu_write_embedded` | Shared with the I/O flow graph. Receive uses three entries: the lightweight write, which turns a whole-block buffer into a dirty record directly; the ordinary write, which copies into dbufs; and the embedded write, which stores data in the block pointer. |
| `dbuf_dirty` | dbuf_dirty() + dirty records | 0 | `open` | `module/zfs/dbuf.c` | `dbuf_dirty`, `dbuf_dirty_lightweight`, `dmu_buf_will_dirty`, `dmu_buf_write_embedded`, `dbuf_assign_arcbuf` | Shared with the I/O flow graph. Besides ordinary dirty records on dbufs, receive creates lightweight dirty records that hold only an abd and its write properties, and dirty records whose overridden block pointer holds embedded data. |
| `dnode` | dnode (object) | 0 | `any` | `module/zfs/dnode.c` | `dnode_hold_impl`, `dnode_allocate`, `dnode_reallocate`, `dnode_free_range`, `dnode_setdirty` | Shared with the I/O flow graph. Receive allocates and reallocates dnodes at the object numbers the stream names, frees ranges, and collects the txg's dirty records under the dnode. |
| `zfetch` | Prefetch (dmu_zfetch) | 0 | `open` | `module/zfs/dmu.c` | `dmu_prefetch`, `dbuf_prefetch_impl` | Shared with the I/O flow graph. The receive reader issues explicit prefetches of level-1 indirect blocks for upcoming WRITE records, so the writer finds them in the ARC. |
| `txg_sync` | TXG: syncing (txg_sync_thread) | 1 | `thr` | `module/zfs/txg.c` | `txg_sync_thread`, `txg_wait_synced` | Shared with the I/O flow graph. Sync tasks and failed receives wait here for their txg to reach disk. |
| `spa_sync` | spa_sync() | 1 | `sync` | `module/zfs/spa.c` | `spa_sync`, `spa_sync_iterate_to_convergence` | Shared with the I/O flow graph. Writes one txg, including the received data and the sync tasks of receive begin and end. |
| `dsl_pool_sync` | dsl_pool_sync() | 1 | `sync` | `module/zfs/dsl_pool.c` | `dsl_pool_sync`, `dsl_dataset_sync` | Shared with the I/O flow graph. Syncs the dirty datasets (writing a receiving dataset's saved resume point into its ZAP on the way), then runs the queued sync tasks of that txg. |
| `dbuf_sync` | dbuf_sync_leaf() / dbuf_write() | 1 | `sync` | `module/zfs/dbuf.c` | `dbuf_sync_lightweight`, `dbuf_lightweight_ready` | Shared with the I/O flow graph. A lightweight dirty record from receive becomes a write zio directly from its abd and saved properties, with no dbuf and no ARC buffer involved. |

## 9. Wires

125 wires. A wire runs from the node that hands something over to the node that receives it. `on paths` lists the section 10 paths that use the wire.

| wire | from | to | type | label | on paths |
|---|---|---|---|---|---|
| E001 | `zfs_send_cmd` | `libzfs_send` | `ctl` | zfs_do_send(): without -R or -I the send goes to zfs_send_one() | full_send, incr_send, compressed_send, raw_send |
| E002 | `zfs_send_cmd` | `libzfs_send` | `ctl` | zfs_do_send(): -t goes to zfs_send_resume(), which decodes the token with zfs_send_resume_token_to_nvlist() | resume_send |
| E003 | `zfs_send_cmd` | `libzfs_repl` | `ctl` | zfs_do_send(): -R (or -I) goes to zfs_send() | replication |
| E004 | `libzfs_send` | `lzc_send` | `ctl` | zfs_send_one_cb_impl(): lzc_send_redacted() with lzc_flags_from_sendflags() (-L, -e, -c, -w) | full_send, incr_send, compressed_send, raw_send |
| E005 | `libzfs_send` | `lzc_send` | `ctl` | zfs_send_resume_impl_cb_impl(): guid_to_name() finds the snapshot by the token's toguid; lzc_send_resume_redacted() with the token's object and offset | resume_send |
| E006 | `lzc_send` | `ioc_send` | `ctl` | lzc_send_wrapper() (Linux: a pipe and a copying thread when the output is not a pipe), then lzc_ioctl(ZFS_IOC_SEND_NEW) with fd, fromsnap and the *ok flags | full_send, incr_send, compressed_send, raw_send, resume_send |
| E007 | `libzfs_repl` | `stream_fd` | `stream` | send_prelim_records(): BEGIN marked DMU_COMPOUNDSTREAM with the list of filesystems, snapshots and properties, closed by its own END | replication |
| E008 | `libzfs_repl` | `ioc_send` | `ctl` | dump_filesystems() -> dump_snapshot() -> dump_ioctl(): one legacy ZFS_IOC_SEND per snapshot, incremental from the previous one | replication |
| E009 | `libzfs_repl` | `stream_fd` | `stream` | after the last substream: send_conclusion_record() writes the final END | replication |
| E010 | `ioc_send` | `dmu_send` | `ctl` | zfs_ioc_send_new(): dump_bytes_init() makes dump_bytes() the output function, then dmu_send() | full_send, incr_send, compressed_send, raw_send, resume_send |
| E011 | `ioc_send` | `dmu_send` | `ctl` | zfs_ioc_send() (legacy, used per snapshot by -R): dmu_send_obj() with dataset object numbers | replication |
| E012 | `dmu_send` | `send_setup` | `ctl` | no from point: the snapshot is held (DS_HOLD_FLAG_DECRYPT unless raw) and dmu_send_impl() runs with fromtxg 0 | full_send, compressed_send, raw_send, resume_send, replication |
| E013 | `dmu_send` | `send_from` | `ctl` | from @snapshot: dsl_dataset_hold(), dsl_dataset_is_before() (EXDEV if it is not an earlier snapshot), take its creation txg and guid | incr_send |
| E014 | `dmu_send` | `send_from` | `ctl` | from #bookmark: dsl_bookmark_lookup() checks that the bookmark is an ancestor and returns its creation txg and guid | incr_send |
| E015 | `send_from` | `send_setup` | `ctl` | dmu_send_impl() with ancestor_zb: fromtxg is the from point's creation txg | incr_send |
| E016 | `send_setup` | `dump_record` | `stream` | setup_featureflags(), create_begin_record(): BEGIN with magic, toguid, fromguid, toname and feature flags; dump_record() | full_send, incr_send, compressed_send, raw_send, resume_send, replication |
| E017 | `send_setup` | `dump_record` | `stream` | raw: dsl_crypto_populate_key_nvlist() puts the wrapped keys into the BEGIN payload as crypt_keydata | raw_send |
| E018 | `send_setup` | `send_traverse` | `ctl` | setup_to_thread(): thread_create(send_traverse_thread) with fromtxg; TRAVERSE_NO_DECRYPT for raw, TRAVERSE_HARD when zfs_send_corrupt_data is set | full_send, incr_send, compressed_send, raw_send, resume_send |
| E019 | `send_setup` | `redact_list` | `ctl` | setup_from_thread(), setup_redact_list_thread(); setup_merge_thread() and setup_reader_thread() start the rest | full_send, incr_send, compressed_send, raw_send, resume_send |
| E020 | `send_setup` | `send_traverse` | `ctl` | resume: setup_resume_points() starts the walk at (resume object, block of resume offset) and adds resume_object and resume_offset to the BEGIN nvlist | resume_send |
| E021 | `send_traverse` | `traverse` | `bp` | send_traverse_thread(): traverse_dataset_resume() from the snapshot's root block pointer, pre-order | full_send, incr_send, compressed_send, raw_send, resume_send |
| E022 | `traverse` | `arc_read` | `arc` | traverse_visitbp(): arc_read() of each indirect and dnode block it descends into; traverse_prefetch_metadata() reads ahead | full_send, incr_send, raw_send |
| E023 | `traverse` | `send_traverse` | `bp` | a block pointer born at or before fromtxg is skipped with its whole subtree; send_cb() is called for every other one | full_send, incr_send, compressed_send, raw_send, resume_send |
| E024 | `send_traverse` | `send_merge` | `bp` | send_cb(): range_alloc() (OBJECT, OBJECT_RANGE, DATA, HOLE or REDACT), bqueue_enqueue(); an end-of-stream marker when the walk ends | full_send, incr_send, compressed_send, raw_send, resume_send |
| E025 | `redact_list` | `send_merge` | `ctl` | redact_list_thread(): ranges from dsl_redaction_list_traverse(), or only the end-of-stream marker when there is no list | full_send, incr_send, compressed_send, raw_send, resume_send |
| E026 | `send_merge` | `send_reader` | `bp` | send_merge_thread(): find_next_range() merges the queues in (object, block) order; bqueue_enqueue() to the reader | full_send, incr_send, compressed_send, raw_send, resume_send |
| E027 | `send_reader` | `arc_read` | `arc` | issue_data_read(): arc_read() with ARC_FLAG_CACHED_ONLY; -c asks for ZIO_FLAG_RAW_COMPRESS, -w for ZIO_FLAG_RAW | full_send, incr_send, compressed_send, raw_send, resume_send |
| E028 | `send_reader` | `zio_create` | `zio` | not cached: zio_read() straight into a private abd, completion in dmu_send_read_done(); the block is not added to the ARC | full_send, incr_send, compressed_send, raw_send, resume_send |
| E029 | `send_reader` | `do_dump` | `bp` | send_reader_thread(): the range is queued for the main thread while its read is in flight; dmu_send_impl() takes it with bqueue_dequeue() | full_send, incr_send, compressed_send, raw_send, resume_send |
| E030 | `arc_read` | `do_dump` | `arc` | cache hit: arc_getbuf_func() leaves the arc_buf in the range, and do_dump() sends from it | full_send |
| E031 | `zio_create` | `do_dump` | `abd` | dmu_send_read_done(): cv_broadcast() wakes do_dump(), which was waiting in cv_wait() for this range | full_send, incr_send, compressed_send, raw_send, resume_send |
| E032 | `do_dump` | `dump_obj` | `stream` | OBJECT range: dump_dnode() writes OBJECT with the bonus buffer; a hole in the meta-dnode: dump_freeobjects() | full_send, incr_send, raw_send, resume_send |
| E033 | `do_dump` | `dump_obj` | `stream` | raw only: OBJECT_RANGE range: dump_object_range() with the salt, IV and MAC of the dnode block | raw_send |
| E034 | `dump_obj` | `dump_free` | `stream` | dump_dnode(): dump_free() from the end of the object's data to DMU_OBJECT_END, so the receiver drops anything beyond it | full_send, incr_send |
| E035 | `do_dump` | `dump_data` | `stream` | DATA range: dmu_dump_write() writes WRITE carrying the logical block (decompressed and decrypted) | full_send, incr_send, resume_send |
| E036 | `do_dump` | `dump_data` | `stream` | -c and a compressed block: dmu_dump_write() adds the compression type and drr_compressed_size; the payload is the compressed bytes | compressed_send |
| E037 | `do_dump` | `dump_data` | `stream` | -w: dmu_dump_write() sends the on-disk bytes with the salt and IV from zio_crypt_decode_params_bp() and the MAC from zio_crypt_decode_mac_bp() | raw_send |
| E038 | `do_dump` | `dump_data` | `stream` | block over SPA_OLD_MAXBLOCKSIZE (128K) without -L: dmu_dump_write() per 128K piece, sent uncompressed | full_send |
| E039 | `do_dump` | `dump_data` | `stream` | -e and an embedded block pointer: send_do_embed(), dump_write_embedded() writes WRITE_EMBEDDED with the bytes held in the bp; nothing was read | full_send |
| E040 | `do_dump` | `dump_free` | `stream` | HOLE range in an object: dump_free() starts or extends a pending FREE | full_send, incr_send |
| E041 | `dump_obj` | `dump_record` | `stream` | dump_record() of OBJECT with the bonus buffer as payload (FREEOBJECTS and OBJECT_RANGE have none) | full_send, incr_send, raw_send, resume_send |
| E042 | `dump_data` | `dump_record` | `stream` | dump_record(): the header, then the block as payload | full_send, incr_send, compressed_send, raw_send, resume_send |
| E043 | `dump_free` | `dump_record` | `stream` | a FREE to DMU_OBJECT_END goes out at once through dump_record(); other FREEs wait until the next record cannot be merged | full_send, incr_send |
| E044 | `dump_record` | `stream_fd` | `stream` | fletcher_4_incremental_native() over header and payload; the output function dump_bytes() does zfs_file_write() of each to the fd | full_send, incr_send, compressed_send, raw_send, resume_send, replication |
| E045 | `send_setup` | `dump_record` | `stream` | after the last range: END carrying the checksum of the whole stream (left out for a saved send) | full_send, incr_send, compressed_send, raw_send, resume_send |
| E046 | `stream_fd` | `zfs_recv_cmd` | `stream` | zfs receive reads the stream from standard input (a terminal is refused) | replication, full_recv, incr_recv, raw_recv, interrupted_recv, heal_recv |
| E047 | `stream_fd` | `recv_cksum` | `stream` | receive_read(): zfs_file_read() takes every record after BEGIN straight from the same fd; userspace never copies them | full_recv, incr_recv, raw_recv, interrupted_recv, heal_recv |
| E048 | `recv_ds` | `resume_token` | `ctl` | dsl_dataset_stats(): get_receive_resume_token() from the resume entries of tofs or tofs/%recv; gzip, fletcher-4, hex | interrupted_recv |
| E049 | `resume_token` | `zfs_send_cmd` | `ctl` | the token is copied back to the sending side: zfs send -t token | resume_send, interrupted_recv |
| E050 | `zfs_recv_cmd` | `libzfs_recv` | `ctl` | zfs_do_receive(): zfs_receive() with the -F, -s, -c, -o and -x settings | replication, full_recv, incr_recv, raw_recv, interrupted_recv, heal_recv |
| E051 | `libzfs_recv` | `lzc_recv` | `stream` | zfs_receive_impl() reads and checks BEGIN; a single stream goes to zfs_receive_one(), which checks the destination and calls lzc_receive_with_cmdprops() | replication, full_recv, incr_recv, raw_recv, interrupted_recv |
| E052 | `libzfs_recv` | `lzc_recv` | `stream` | -c: zfs_receive_one() calls lzc_receive_with_heal() for the existing snapshot | heal_recv |
| E053 | `libzfs_recv` | `libzfs_recv_pkg` | `stream` | compound stream: zfs_receive_package() reads the list of filesystems and snapshots with recv_read_nvlist() | replication |
| E054 | `libzfs_recv_pkg` | `libzfs_recv` | `ctl` | recv_incremental_replication() (with -F, recv_destroy() of what the stream no longer has), then zfs_receive_impl() for each substream | replication |
| E055 | `lzc_recv` | `ioc_recv` | `ctl` | recv_impl(): ZFS_IOC_RECV_NEW with begin_record, input_fd and the force / resumable / heal flags, or legacy ZFS_IOC_RECV when nothing needs the new interface | replication, full_recv, incr_recv, raw_recv, interrupted_recv, heal_recv |
| E056 | `ioc_recv` | `recv_begin` | `ctl` | zfs_ioc_recv_new() -> zfs_ioc_recv_impl(): zfs_file_get(input_fd), dmu_recv_begin() | full_recv, incr_recv, raw_recv, interrupted_recv, heal_recv |
| E057 | `recv_begin` | `sync_task` | `ctl` | fletcher_4_incremental_native() of BEGIN starts the stream checksum; dsl_sync_task(dmu_recv_begin_check, dmu_recv_begin_sync) | full_recv, incr_recv, raw_recv, interrupted_recv, heal_recv |
| E058 | `recv_begin` | `sync_task` | `ctl` | RESUMING feature flag: dsl_sync_task(dmu_recv_resume_begin_check, dmu_recv_resume_begin_sync) | interrupted_recv |
| E059 | `sync_task` | `txg_sync` | `tx` | dsl_sync_task_common(): check function in open context, task queued on the open txg with txg_list_add_tail(), txg_wait_synced() | full_recv, incr_recv, raw_recv, interrupted_recv, heal_recv |
| E060 | `txg_sync` | `spa_sync` | `tx` | txg_sync_thread() -> spa_sync() | full_recv, incr_recv, raw_recv, interrupted_recv, heal_recv |
| E061 | `spa_sync` | `dsl_pool_sync` | `tx` | spa_sync_iterate_to_convergence() -> dsl_pool_sync() | full_recv, incr_recv, raw_recv, interrupted_recv, heal_recv |
| E062 | `dsl_pool_sync` | `sync_task` | `ctl` | dsl_pool_sync(): after the dirty datasets, dsl_sync_task_sync() for each task queued on this txg | full_recv, incr_recv, raw_recv, interrupted_recv, heal_recv |
| E063 | `sync_task` | `recv_begin_sync` | `ctl` | dsl_sync_task_sync(): the check function again, then the sync function, in syncing context | full_recv, incr_recv, raw_recv, interrupted_recv, heal_recv |
| E064 | `recv_begin_sync` | `recv_ds` | `ctl` | target missing: dsl_dataset_create_sync() under the final name (on the origin for a clone stream), flagged DS_FLAG_INCONSISTENT | full_recv, raw_recv, interrupted_recv |
| E065 | `recv_begin_sync` | `recv_ds` | `ctl` | target exists: recv_begin_check_existing_impl() finds the snapshot with the stream's fromguid; dsl_dataset_create_sync() makes tofs/%recv as its clone, flagged DS_FLAG_INCONSISTENT | incr_recv, raw_recv |
| E066 | `recv_begin_sync` | `recv_ds` | `ctl` | -s: dsl_dataset_zapify() and the DS_FIELD_RESUME_* entries (toguid, toname, object 1, offset 0, bytes 0, the stream flags) | interrupted_recv |
| E067 | `recv_begin_sync` | `recv_ds` | `ctl` | resume: dsl_dataset_own_force() on tofs/%recv, or tofs; the check required it inconsistent, unowned and with the stream's toguid and fromguid | interrupted_recv |
| E068 | `recv_begin_sync` | `recv_ds` | `ctl` | -c: no new dataset; dsl_dataset_snap_lookup() selects the existing snapshot to heal | heal_recv |
| E069 | `ioc_recv` | `recv_stream` | `ctl` | zfs_ioc_recv_impl(): received and -o / -x properties are set with zfs_set_prop_nvlist() first, then dmu_recv_stream() | full_recv, incr_recv, raw_recv, interrupted_recv, heal_recv |
| E070 | `recv_stream` | `recv_crypt` | `ctl` | raw: dsl_crypto_recv_raw() with the BEGIN nvlist's crypt_keydata; for an existing dataset the key waits for the end sync task | raw_recv |
| E071 | `recv_stream` | `recv_ds` | `ctl` | resume: resume_check() requires the BEGIN nvlist's resume_object and resume_offset to equal the saved DS_FIELD_RESUME_OBJECT and OFFSET | interrupted_recv |
| E072 | `recv_stream` | `recv_cksum` | `stream` | receive_read_record(): recv_check_drr_write() and its siblings validate the header, receive_read_payload_and_next_header() reads the payload and the next header | full_recv, incr_recv, raw_recv, interrupted_recv, heal_recv |
| E073 | `recv_cksum` | `recv_stream` | `stream` | receive_cksum() over payload and header; the result must equal the next header's checksum, and END's checksum the drc_prev_cksum of the whole stream | full_recv, incr_recv, raw_recv, interrupted_recv, heal_recv |
| E074 | `recv_cksum` | `recv_stream` | `ctl` | failure: an early end of the stream gives ZFS_ERR_STREAM_TRUNCATED, a checksum mismatch ECKSUM; the read loop stops | interrupted_recv |
| E075 | `recv_stream` | `recv_writer` | `stream` | thread_create(receive_writer_thread); bqueue_enqueue() of each record, the queue limited by zfs_recv_queue_length bytes | full_recv, incr_recv, raw_recv, interrupted_recv, heal_recv |
| E076 | `recv_stream` | `zfetch` | `ctl` | receive_read_prefetch(): dmu_prefetch() of the level-1 indirect blocks a WRITE will need, unless the object is on the ignore list | full_recv, incr_recv |
| E077 | `zfetch` | `arc_read` | `arc` | dmu_prefetch_by_dnode() -> dbuf_prefetch_impl() -> asynchronous arc_read() | full_recv, incr_recv |
| E078 | `recv_writer` | `recv_object` | `stream` | receive_process_record(): OBJECT -> receive_object() | full_recv, incr_recv, raw_recv, interrupted_recv |
| E079 | `recv_writer` | `recv_freeobjects` | `stream` | FREEOBJECTS -> receive_freeobjects(); FREE and REDACT -> receive_free() | full_recv, incr_recv |
| E080 | `recv_writer` | `recv_write` | `stream` | WRITE -> receive_process_write_record(), which adds it to the batch; any other record type first runs flush_write_batch() | full_recv, incr_recv, raw_recv, interrupted_recv |
| E081 | `recv_writer` | `recv_embedded` | `stream` | WRITE_EMBEDDED -> receive_write_embedded(); SPILL -> receive_spill() | full_recv |
| E082 | `recv_writer` | `recv_objrange` | `stream` | raw: OBJECT_RANGE -> receive_object_range() | raw_recv |
| E083 | `recv_writer` | `recv_heal` | `stream` | -c: every record but WRITE is dropped; receive_process_write_record() takes its heal branch | heal_recv |
| E084 | `recv_objrange` | `recv_object` | `ctl` | or_crypt_params_present: the next receive_object() stamps the dnode block with dmu_buf_set_crypt_params() | raw_recv |
| E085 | `recv_object` | `dmu_tx` | `tx` | dmu_tx_create(), dmu_tx_hold_bonus(), dmu_tx_hold_write(), dmu_tx_assign(DMU_TX_WAIT) | full_recv, incr_recv, raw_recv, interrupted_recv |
| E086 | `recv_object` | `dmu_object` | `ctl` | free number: dmu_object_claim_dnsize(); type, block size or bonus changed: dmu_object_reclaim_dnsize() | full_recv, incr_recv, raw_recv |
| E087 | `dmu_object` | `dnode` | `ctl` | dnode_hold_impl(DNODE_MUST_BE_FREE) and dnode_allocate(), or dnode_reallocate() | full_recv, incr_recv, raw_recv |
| E088 | `recv_object` | `dbuf_dirty` | `dbuf` | bonus buffer: dmu_bonus_hold_by_dnode(), dmu_buf_will_dirty(), the record's bonus payload copied in | full_recv, incr_recv, raw_recv |
| E089 | `recv_object` | `recv_resume_state` | `ctl` | save_resume_state(object, offset 0) before dmu_tx_commit() | full_recv, incr_recv, interrupted_recv |
| E090 | `recv_write` | `dmu_tx` | `tx` | flush_write_batch_impl(): one tx for the batch, dmu_tx_hold_write_by_dnode() from the first offset to the last, dmu_tx_assign() | full_recv, incr_recv, raw_recv, interrupted_recv |
| E091 | `recv_write` | `dmu_write` | `abd` | record of the object's block size: dmu_write_policy() props, dmu_lightweight_write_by_dnode(); the record's abd is handed over, not copied | full_recv, incr_recv, interrupted_recv |
| E092 | `recv_write` | `dmu_write` | `abd` | compressed record: zp_compress from the record and ZIO_FLAG_RAW_COMPRESS, dmu_lightweight_write_by_dnode(); written still compressed | full_recv |
| E093 | `recv_write` | `dmu_write` | `abd` | raw record: zp_encrypt with the record's salt, IV and MAC, ZIO_FLAG_RAW, dmu_lightweight_write_by_dnode(); written still encrypted | raw_recv |
| E094 | `recv_write` | `dmu_write` | `dbuf` | record size differs from the object's block size: decompress if needed, then dmu_write_by_dnode() | incr_recv |
| E095 | `recv_write` | `recv_resume_state` | `ctl` | save_resume_state(object, offset) for each WRITE applied | full_recv, interrupted_recv |
| E096 | `recv_freeobjects` | `dmu_free` | `ctl` | receive_free(): dmu_free_long_range(); receive_freeobjects(): receive_defer_free_object(), which is dmu_free_long_range() plus dmu_object_free() | full_recv, incr_recv |
| E097 | `dmu_free` | `dnode` | `ctl` | dmu_free_long_range_impl(): per chunk a tx with dmu_tx_hold_free(), then dnode_free_range() | full_recv, incr_recv |
| E098 | `dmu_write` | `dbuf_dirty` | `abd` | dbuf_dirty_lightweight(): a dirty record holding the abd and its write properties, with no dbuf and no ARC buffer | full_recv, incr_recv, raw_recv, interrupted_recv |
| E099 | `dmu_write` | `dbuf_dirty` | `dbuf` | dmu_write_impl(): dmu_buf_will_fill_flags() or dmu_buf_will_dirty_flags(), then memcpy() into the dbuf | incr_recv |
| E100 | `recv_embedded` | `dmu_write` | `bp` | receive_write_embedded(): dmu_write_embedded() (dmu_write_by_dnode() of the decompressed data when the sizes do not match) | full_recv |
| E101 | `dmu_write` | `dbuf_dirty` | `bp` | dmu_buf_write_embedded(): dmu_buf_will_not_fill(); the data is encoded into the dirty record's block pointer, no block is allocated | full_recv |
| E102 | `recv_embedded` | `dbuf_dirty` | `arc` | receive_spill(): arc_loan_buf() (raw: arc_loan_raw_buf()), then dbuf_assign_arcbuf() on the spill dbuf | full_recv |
| E103 | `recv_embedded` | `dmu_tx` | `tx` | dmu_tx_hold_write_by_dnode() or dmu_tx_hold_spill(), dmu_tx_assign() | full_recv |
| E104 | `dbuf_dirty` | `dnode` | `ctl` | the dirty record joins the dnode's dirty records for this txg (directly, or under its indirect parent), dnode_setdirty() | full_recv, incr_recv |
| E105 | `recv_resume_state` | `dsl_pool_sync` | `ctl` | ds_resume_object, offset and bytes are kept per txg; dsl_dataset_sync() writes them into the dataset's ZAP when that txg syncs | interrupted_recv |
| E106 | `dsl_pool_sync` | `dbuf_sync` | `dbuf` | dsl_dataset_sync() -> dmu_objset_sync() ... dbuf_sync_list(): a dirty record without a dbuf goes to dbuf_sync_lightweight() | full_recv, incr_recv, raw_recv |
| E107 | `dbuf_sync` | `zio_create` | `zio` | dbuf_sync_lightweight(): zio_write() of the record's abd with its saved props; RAW_COMPRESS and RAW mean no recompression and no re-encryption | full_recv, incr_recv, raw_recv |
| E108 | `recv_writer` | `recv_stream` | `ctl` | end-of-stream marker: receive_defer_flush(), flush_write_batch(), then cv_signal() wakes dmu_recv_stream() | full_recv, incr_recv, raw_recv, interrupted_recv, heal_recv |
| E109 | `ioc_recv` | `recv_end` | `ctl` | zfs_suspend_fs() if tofs is mounted (zvol_suspend() for a volume), then dmu_recv_end() | full_recv, incr_recv, raw_recv, interrupted_recv, heal_recv |
| E110 | `recv_end` | `sync_task` | `ctl` | dmu_recv_new_end() or dmu_recv_existing_end(): dsl_sync_task(dmu_recv_end_check, dmu_recv_end_sync) | full_recv, incr_recv, raw_recv, interrupted_recv, heal_recv |
| E111 | `sync_task` | `recv_end_sync` | `ctl` | dsl_sync_task_sync(): dmu_recv_end_check() again, then dmu_recv_end_sync(), all in one txg | full_recv, incr_recv, raw_recv, interrupted_recv, heal_recv |
| E112 | `recv_end_sync` | `recv_ds` | `ctl` | new dataset: dsl_dataset_snapshot_sync_impl() takes tosnap and its ds_guid is set to the sender's; the DS_FLAG_INCONSISTENT flag and the resume entries (DS_FIELD_RESUME_OBJECT and the rest) are removed | full_recv, raw_recv, interrupted_recv |
| E113 | `recv_end_sync` | `recv_ds` | `ctl` | existing: dsl_dataset_clone_swap_sync_impl() swaps %recv's contents into tofs, dsl_dataset_snapshot_sync_impl() with ds_guid set to the sender's, dsl_destroy_head_sync_impl() of %recv | incr_recv, raw_recv |
| E114 | `recv_end_sync` | `recv_ds` | `ctl` | -F: dsl_destroy_snapshot_sync_impl() of every snapshot of tofs newer than the from snapshot, before the swap | incr_recv |
| E115 | `recv_end_sync` | `recv_crypt` | `ctl` | raw into an existing dataset: dsl_crypto_recv_raw_key_sync() installs the received keys in the same txg as the swap | raw_recv |
| E116 | `recv_end` | `ioc_recv` | `ctl` | back in zfs_ioc_recv_impl(): zfs_resume_fs() reopens the mounted dataset on its new contents; delayed properties are set with zfs_set_prop_nvlist() | full_recv, incr_recv, raw_recv, interrupted_recv, heal_recv |
| E117 | `recv_stream` | `recv_cleanup` | `ctl` | error: dmu_recv_cleanup_ds() (dmu_recv_end() calls it too when the end task fails) | interrupted_recv |
| E118 | `recv_cleanup` | `txg_sync` | `tx` | txg_wait_synced(): the last saved resume point reaches disk | interrupted_recv |
| E119 | `recv_cleanup` | `recv_ds` | `ctl` | -s and data received: dsl_dataset_disown() leaves the inconsistent dataset in place; otherwise dsl_destroy_head() | interrupted_recv |
| E120 | `recv_heal` | `arc_read` | `arc` | dmu_buf_hold_noread(), dbuf_read(DB_RF_CANFAIL) of the block; only ECKSUM marks it for healing | heal_recv |
| E121 | `recv_heal` | `zio_create` | `zio` | do_corrective_recv(): recompress (and re-encrypt) to the on-disk form, zio_checksum_compute() must equal the bp's checksum, zio_rewrite() of the same DVAs, zio_read() to verify | heal_recv |
| E122 | `zio_create` | `recv_heal` | `ctl` | corrective_read_done(): spa_remove_error() takes the healed block off the pool's error log | heal_recv |
| E123 | `recv_crypt` | `sync_task` | `ctl` | dsl_crypto_recv_raw(): its own dsl_sync_task() sets up the encrypted objset, and the key too for a new dataset | raw_recv |
| E124 | `admin` | `zfs_send_cmd` | `ctl` | runs zfs send [-i | -I from] [-R] [-c] [-w] [-L] [-e] snapshot, or zfs send -t token | full_send, incr_send, compressed_send, raw_send, resume_send, replication |
| E125 | `admin` | `zfs_recv_cmd` | `ctl` | runs zfs receive [-F] [-s] [-c] target, with the stream on standard input | full_recv, incr_recv, raw_recv, interrupted_recv, heal_recv |

## 10. Paths

11 named paths, 430 steps in total. Each step is one wire; the caption for a step is that wire's label. Every wire in section 9 is on at least one path. The category is the heading the path is listed under in the left panel. Path syntax, alternative groups and notes follow section 10 of `../zfs-io-flow-diagram-spec.md`.

### 10.1 `full_send` - Full send (zfs send pool/fs@snap)

Category: Send. A full stream of one snapshot. Every block is visited; each object produces an OBJECT record, a FREE for the space past its end, and one record per data block. The alternatives show how one block is turned into records.

Alternatives:
- `block`: `normal` Ordinary data block; `split` Block over 128K sent without -L; `embedded` Embedded block pointer sent with -e; `hole` Hole (FREE record, nothing read)
- `cache`: `miss` Block not in the ARC; `hit` Block already cached in the ARC

```
 1  E124  admin -> zfs_send_cmd
 2  E001  zfs_send_cmd -> libzfs_send
 3  E004  libzfs_send -> lzc_send
 4  E006  lzc_send -> ioc_send
 5  E010  ioc_send -> dmu_send
 6  E012  dmu_send -> send_setup
 7  E016  send_setup -> dump_record  "fromguid is 0: a full stream"
 8  E044  dump_record -> stream_fd
 9  E018  send_setup -> send_traverse  "fromtxg is 0, so every block is visited"
10  E019  send_setup -> redact_list
11  E021  send_traverse -> traverse
12  E022  traverse -> arc_read
13  E023  traverse -> send_traverse
14  E024  send_traverse -> send_merge
15  E025  redact_list -> send_merge  "no redaction list: only the end-of-stream marker"
16  E026  send_merge -> send_reader
17  E029  send_reader -> do_dump  "an OBJECT range: each object comes before its data"
18  E032  do_dump -> dump_obj
19  E041  dump_obj -> dump_record
20  E034  dump_obj -> dump_free
21  E043  dump_free -> dump_record
22  E044  dump_record -> stream_fd
23  E027  send_reader -> arc_read  [block: normal, split]
24  E028  send_reader -> zio_create  [block: normal, split]  [cache: miss]
25  E029  send_reader -> do_dump  "the block's range follows"
26  E030  arc_read -> do_dump  [block: normal, split]  [cache: hit]
27  E031  zio_create -> do_dump  [block: normal, split]  [cache: miss]
28  E035  do_dump -> dump_data  [block: normal]
29  E038  do_dump -> dump_data  [block: split]
30  E039  do_dump -> dump_data  [block: embedded]
31  E042  dump_data -> dump_record  [block: normal, split, embedded]
32  E040  do_dump -> dump_free  [block: hole]
33  E043  dump_free -> dump_record  [block: hole]  "flushed by the next record that cannot be merged"
34  E044  dump_record -> stream_fd
35  E045  send_setup -> dump_record  "after the end-of-stream marker reaches the main thread"
36  E044  dump_record -> stream_fd
```
Ends: The whole snapshot is in the stream, BEGIN to END. Continue on the receiving side with path full_recv.

### 10.2 `incr_send` - Incremental send (zfs send -i)

Category: Send. The stream contains only what changed between the from point and the snapshot. The traversal prunes by birth txg, so unchanged subtrees are never read; deleted data shows up as holes born after the from point and becomes FREE or FREEOBJECTS records.

Alternatives:
- `source`: `snap` From a snapshot (@); `bookmark` From a bookmark (#)

```
 1  E124  admin -> zfs_send_cmd
 2  E001  zfs_send_cmd -> libzfs_send
 3  E004  libzfs_send -> lzc_send
 4  E006  lzc_send -> ioc_send
 5  E010  ioc_send -> dmu_send
 6  E013  dmu_send -> send_from  [source: snap]
 7  E014  dmu_send -> send_from  [source: bookmark]  "the bookmark holds no blocks, only the txg and guid of its snapshot"
 8  E015  send_from -> send_setup
 9  E016  send_setup -> dump_record  "BEGIN carries fromguid; the receiver must have a snapshot with that guid"
10  E044  dump_record -> stream_fd
11  E018  send_setup -> send_traverse  "fromtxg is the from point's creation txg"
12  E019  send_setup -> redact_list
13  E021  send_traverse -> traverse
14  E022  traverse -> arc_read  "only indirect blocks born after fromtxg are read"
15  E023  traverse -> send_traverse  "an unchanged subtree costs one block pointer comparison"
16  E024  send_traverse -> send_merge
17  E025  redact_list -> send_merge
18  E026  send_merge -> send_reader
19  E029  send_reader -> do_dump
20  E032  do_dump -> dump_obj  "a new or changed object; a freed object number appears as a meta-dnode hole and becomes FREEOBJECTS"
21  E041  dump_obj -> dump_record
22  E034  dump_obj -> dump_free
23  E043  dump_free -> dump_record
24  E044  dump_record -> stream_fd
25  E027  send_reader -> arc_read
26  E028  send_reader -> zio_create
27  E029  send_reader -> do_dump
28  E031  zio_create -> do_dump
29  E035  do_dump -> dump_data  "only blocks written after the from point"
30  E042  dump_data -> dump_record
31  E040  do_dump -> dump_free  "a hole born after fromtxg: data deleted or truncated since the from point"
32  E043  dump_free -> dump_record
33  E044  dump_record -> stream_fd
34  E045  send_setup -> dump_record
35  E044  dump_record -> stream_fd
```
Ends: The stream holds only the changes. Continue on the receiving side with path incr_recv.

### 10.3 `compressed_send` - Compressed send (zfs send -c)

Category: Send. With -c a block that is compressed on disk is read and sent in its compressed form, so neither side spends CPU on decompression and the stream is as small as the data on disk.

```
 1  E124  admin -> zfs_send_cmd
 2  E001  zfs_send_cmd -> libzfs_send  "-c sets LZC_SEND_FLAG_COMPRESS"
 3  E004  libzfs_send -> lzc_send
 4  E006  lzc_send -> ioc_send
 5  E010  ioc_send -> dmu_send
 6  E012  dmu_send -> send_setup
 7  E016  send_setup -> dump_record  "feature flags COMPRESSED, plus LZ4 or ZSTD when the pool or dataset uses them"
 8  E044  dump_record -> stream_fd
 9  E018  send_setup -> send_traverse
10  E019  send_setup -> redact_list
11  E021  send_traverse -> traverse
12  E023  traverse -> send_traverse
13  E024  send_traverse -> send_merge
14  E025  redact_list -> send_merge
15  E026  send_merge -> send_reader
16  E027  send_reader -> arc_read  "ZIO_FLAG_RAW_COMPRESS, except for metadata, embedded and byteswapped blocks and blocks split for lack of -L"
17  E028  send_reader -> zio_create  "the read returns the compressed bytes and skips decompression"
18  E029  send_reader -> do_dump
19  E031  zio_create -> do_dump
20  E036  do_dump -> dump_data
21  E042  dump_data -> dump_record  "the payload is the physical size, not the logical size"
22  E044  dump_record -> stream_fd
23  E045  send_setup -> dump_record
24  E044  dump_record -> stream_fd
```
Ends: The stream carries compressed WRITE records. The receiver writes them still compressed (path full_recv, alternative compressed).

### 10.4 `raw_send` - Raw send of an encrypted dataset (zfs send -w)

Category: Send. Blocks are sent exactly as they are on disk, compressed and encrypted, together with the parameters needed to store them unchanged elsewhere. The keys need not be loaded, and the receiving system never sees plaintext.

```
 1  E124  admin -> zfs_send_cmd
 2  E001  zfs_send_cmd -> libzfs_send  "-w also sets -c, -e and -L"
 3  E004  libzfs_send -> lzc_send
 4  E006  lzc_send -> ioc_send
 5  E010  ioc_send -> dmu_send
 6  E012  dmu_send -> send_setup  "no DS_HOLD_FLAG_DECRYPT: the dataset's key need not be loaded"
 7  E016  send_setup -> dump_record  "feature flag RAW; EMBED_DATA is never set for an encrypted dataset"
 8  E017  send_setup -> dump_record
 9  E044  dump_record -> stream_fd
10  E018  send_setup -> send_traverse  "physical birth txgs are compared"
11  E019  send_setup -> redact_list
12  E021  send_traverse -> traverse
13  E022  traverse -> arc_read
14  E023  traverse -> send_traverse  "meta-dnode data blocks also become OBJECT_RANGE ranges"
15  E024  send_traverse -> send_merge
16  E025  redact_list -> send_merge
17  E026  send_merge -> send_reader
18  E029  send_reader -> do_dump
19  E033  do_dump -> dump_obj
20  E041  dump_obj -> dump_record
21  E032  do_dump -> dump_obj  "the raw OBJECT also carries nlevels, maxblkid and the whole encrypted bonus area"
22  E041  dump_obj -> dump_record
23  E027  send_reader -> arc_read
24  E028  send_reader -> zio_create  "ZIO_FLAG_RAW: still compressed and encrypted"
25  E029  send_reader -> do_dump
26  E031  zio_create -> do_dump
27  E037  do_dump -> dump_data
28  E042  dump_data -> dump_record
29  E044  dump_record -> stream_fd
30  E045  send_setup -> dump_record
31  E044  dump_record -> stream_fd
```
Ends: The stream holds ciphertext, MACs and wrapped keys. Continue with path raw_recv.

### 10.5 `resume_send` - Resuming an interrupted transfer (zfs send -t)

Category: Send. The receiver's resume token says which snapshot was being sent and the last object and offset the receiver had safely on disk. The sender starts a new stream at that point, with the same flags as the original.

```
 1  E124  admin -> zfs_send_cmd
 2  E049  resume_token -> zfs_send_cmd
 3  E002  zfs_send_cmd -> libzfs_send
 4  E005  libzfs_send -> lzc_send
 5  E006  lzc_send -> ioc_send  "resume_object and resume_offset are added to the arguments"
 6  E010  ioc_send -> dmu_send
 7  E012  dmu_send -> send_setup  "a full stream; an incremental one also goes through send_from as in incr_send"
 8  E020  send_setup -> send_traverse
 9  E016  send_setup -> dump_record  "feature flag RESUMING; the receiver checks the nvlist's resume point"
10  E044  dump_record -> stream_fd
11  E018  send_setup -> send_traverse
12  E019  send_setup -> redact_list
13  E021  send_traverse -> traverse
14  E023  traverse -> send_traverse  "resume_skip_check() skips every block before the resume point"
15  E024  send_traverse -> send_merge
16  E025  redact_list -> send_merge
17  E026  send_merge -> send_reader
18  E029  send_reader -> do_dump
19  E032  do_dump -> dump_obj  "the resume object's OBJECT record is sent again; objects before it are not"
20  E041  dump_obj -> dump_record
21  E027  send_reader -> arc_read
22  E028  send_reader -> zio_create
23  E029  send_reader -> do_dump
24  E031  zio_create -> do_dump
25  E035  do_dump -> dump_data  "starting with the block at the resume offset, which the receiver applied last"
26  E042  dump_data -> dump_record
27  E044  dump_record -> stream_fd
28  E045  send_setup -> dump_record
29  E044  dump_record -> stream_fd
```
Ends: A stream that starts where the interrupted one stopped. The receiver accepts it as shown in the second half of path interrupted_recv.

### 10.6 `replication` - Replication stream (zfs send -R, zfs receive -F)

Category: Send. A -R stream is a userspace package around ordinary per-snapshot streams. The kernel never sees the package: the sender asks for one substream at a time, and the receiver unpacks the list, reconciles the target with it and receives each substream in turn.

```
 1  E124  admin -> zfs_send_cmd
 2  E003  zfs_send_cmd -> libzfs_repl
 3  E007  libzfs_repl -> stream_fd
 4  E008  libzfs_repl -> ioc_send  "one substream per snapshot, built as in full_send or incr_send"
 5  E011  ioc_send -> dmu_send
 6  E012  dmu_send -> send_setup  "the first snapshot of each filesystem; later ones are incremental from the previous snapshot"
 7  E016  send_setup -> dump_record
 8  E044  dump_record -> stream_fd
 9  E009  libzfs_repl -> stream_fd
10  E046  stream_fd -> zfs_recv_cmd
11  E050  zfs_recv_cmd -> libzfs_recv
12  E053  libzfs_recv -> libzfs_recv_pkg
13  E054  libzfs_recv_pkg -> libzfs_recv  "-F: snapshots and filesystems deleted on the sender are destroyed here"
14  E051  libzfs_recv -> lzc_recv  "each substream as in full_recv or incr_recv"
15  E055  lzc_recv -> ioc_recv
```
Ends: Every filesystem and snapshot of the tree has been received; each substream switched into place on its own (path incr_recv).

### 10.7 `full_recv` - Full receive into a new dataset

Category: Receive. The target does not exist yet. A begin sync task creates it, inconsistent; the writer thread applies OBJECT, WRITE, FREE and other records in ordinary transactions; an end sync task snapshots it and clears the inconsistent flag in one txg.

Alternatives:
- `stream`: `plain` Records carry logical blocks; `compressed` Stream sent with -c

```
 1  E125  admin -> zfs_recv_cmd
 2  E046  stream_fd -> zfs_recv_cmd
 3  E050  zfs_recv_cmd -> libzfs_recv
 4  E051  libzfs_recv -> lzc_recv
 5  E055  lzc_recv -> ioc_recv
 6  E056  ioc_recv -> recv_begin
 7  E057  recv_begin -> sync_task
 8  E059  sync_task -> txg_sync
 9  E060  txg_sync -> spa_sync
10  E061  spa_sync -> dsl_pool_sync
11  E062  dsl_pool_sync -> sync_task
12  E063  sync_task -> recv_begin_sync
13  E064  recv_begin_sync -> recv_ds
14  E069  ioc_recv -> recv_stream
15  E075  recv_stream -> recv_writer
16  E072  recv_stream -> recv_cksum
17  E047  stream_fd -> recv_cksum
18  E073  recv_cksum -> recv_stream
19  E076  recv_stream -> zfetch
20  E077  zfetch -> arc_read
21  E078  recv_writer -> recv_object
22  E085  recv_object -> dmu_tx
23  E086  recv_object -> dmu_object
24  E087  dmu_object -> dnode
25  E088  recv_object -> dbuf_dirty
26  E104  dbuf_dirty -> dnode
27  E089  recv_object -> recv_resume_state  "a no-op without -s"
28  E080  recv_writer -> recv_write
29  E090  recv_write -> dmu_tx
30  E091  recv_write -> dmu_write  [stream: plain]
31  E092  recv_write -> dmu_write  [stream: compressed]
32  E098  dmu_write -> dbuf_dirty
33  E104  dbuf_dirty -> dnode
34  E095  recv_write -> recv_resume_state
35  E079  recv_writer -> recv_freeobjects
36  E096  recv_freeobjects -> dmu_free
37  E097  dmu_free -> dnode
38  E081  recv_writer -> recv_embedded  "embedded blocks (sent with -e) and spill blocks"
39  E103  recv_embedded -> dmu_tx
40  E100  recv_embedded -> dmu_write
41  E101  dmu_write -> dbuf_dirty
42  E102  recv_embedded -> dbuf_dirty
43  E072  recv_stream -> recv_cksum  "the reader reaches END"
44  E073  recv_cksum -> recv_stream  "END's checksum matches: the stream is complete"
45  E108  recv_writer -> recv_stream
46  E109  ioc_recv -> recv_end
47  E110  recv_end -> sync_task
48  E059  sync_task -> txg_sync
49  E060  txg_sync -> spa_sync
50  E061  spa_sync -> dsl_pool_sync
51  E106  dsl_pool_sync -> dbuf_sync  "data still dirty in this txg; earlier txgs wrote theirs the same way as they synced"
52  E107  dbuf_sync -> zio_create
53  E062  dsl_pool_sync -> sync_task
54  E111  sync_task -> recv_end_sync
55  E112  recv_end_sync -> recv_ds
56  E116  recv_end -> ioc_recv
```
Ends: The new dataset exists with snapshot tosnap, whose guid equals the sender's, ready to be the base of the next incremental receive.

### 10.8 `incr_recv` - Incremental receive into an existing dataset (with or without -F)

Category: Receive. The records go into tofs/%recv, a clone of the matching snapshot, while tofs stays mounted and unchanged. One sync task then swaps the clone's contents into tofs and takes the new snapshot. With -F the from snapshot may be older than the latest one, and newer snapshots and local changes are discarded in the same txg.

Alternatives:
- `force`: `plain` Without -F; `force` With -F (zfs receive -F)
- `blocks`: `same` Records match the object block sizes; `larger` Stream sent with -L into a dataset first received without -L

```
 1  E125  admin -> zfs_recv_cmd
 2  E046  stream_fd -> zfs_recv_cmd
 3  E050  zfs_recv_cmd -> libzfs_recv
 4  E051  libzfs_recv -> lzc_recv
 5  E055  lzc_recv -> ioc_recv
 6  E056  ioc_recv -> recv_begin
 7  E057  recv_begin -> sync_task
 8  E059  sync_task -> txg_sync
 9  E060  txg_sync -> spa_sync
10  E061  spa_sync -> dsl_pool_sync
11  E062  dsl_pool_sync -> sync_task
12  E063  sync_task -> recv_begin_sync  [force: plain]  "tofs must be unmodified since its latest snapshot, and that snapshot must be the from snapshot (ETXTBSY)"
13  E063  sync_task -> recv_begin_sync  [force: force]  "the from snapshot may be older than the latest; changes since it will be discarded"
14  E065  recv_begin_sync -> recv_ds
15  E069  ioc_recv -> recv_stream  "tofs stays mounted and readable; every write goes to the hidden tofs/%recv"
16  E075  recv_stream -> recv_writer
17  E072  recv_stream -> recv_cksum
18  E047  stream_fd -> recv_cksum
19  E073  recv_cksum -> recv_stream
20  E076  recv_stream -> zfetch
21  E077  zfetch -> arc_read
22  E078  recv_writer -> recv_object  "changed objects; an object with a new type or block size is reclaimed and its old contents freed"
23  E085  recv_object -> dmu_tx
24  E086  recv_object -> dmu_object
25  E087  dmu_object -> dnode
26  E088  recv_object -> dbuf_dirty
27  E089  recv_object -> recv_resume_state
28  E080  recv_writer -> recv_write
29  E090  recv_write -> dmu_tx
30  E091  recv_write -> dmu_write  [blocks: same]
31  E098  dmu_write -> dbuf_dirty  [blocks: same]
32  E094  recv_write -> dmu_write  [blocks: larger]  "the object keeps the 128K block size it got from the first stream"
33  E099  dmu_write -> dbuf_dirty  [blocks: larger]
34  E104  dbuf_dirty -> dnode
35  E079  recv_writer -> recv_freeobjects  "data and objects deleted on the sender since the from snapshot"
36  E096  recv_freeobjects -> dmu_free
37  E097  dmu_free -> dnode
38  E072  recv_stream -> recv_cksum
39  E073  recv_cksum -> recv_stream
40  E108  recv_writer -> recv_stream
41  E109  ioc_recv -> recv_end  "online receive: the filesystem is suspended only for the switch"
42  E110  recv_end -> sync_task
43  E059  sync_task -> txg_sync
44  E060  txg_sync -> spa_sync
45  E061  spa_sync -> dsl_pool_sync
46  E106  dsl_pool_sync -> dbuf_sync
47  E107  dbuf_sync -> zio_create
48  E062  dsl_pool_sync -> sync_task
49  E111  sync_task -> recv_end_sync
50  E114  recv_end_sync -> recv_ds  [force: force]
51  E113  recv_end_sync -> recv_ds
52  E116  recv_end -> ioc_recv
```
Ends: tofs now has the received contents and the new snapshot, with the sender's guid; tofs/%recv is gone. Readers saw the old contents until the switch txg and the new ones after it.

### 10.9 `raw_recv` - Raw receive (the data stays encrypted)

Category: Receive. A raw stream is stored without ever being decrypted: the wrapped keys go into the dataset's crypto key object, each dnode block keeps the sender's salt, IV and MAC, and each data block is written as the ciphertext it arrived as.

Alternatives:
- `target`: `new` Into a new dataset; `existing` Incremental into an existing raw-received dataset

```
 1  E125  admin -> zfs_recv_cmd
 2  E046  stream_fd -> zfs_recv_cmd
 3  E050  zfs_recv_cmd -> libzfs_recv
 4  E051  libzfs_recv -> lzc_recv
 5  E055  lzc_recv -> ioc_recv  "a raw receive always uses ZFS_IOC_RECV_NEW"
 6  E056  ioc_recv -> recv_begin
 7  E057  recv_begin -> sync_task  "check: the encryption feature is enabled, the stream has no embedded data and has the spill-block flag"
 8  E059  sync_task -> txg_sync
 9  E060  txg_sync -> spa_sync
10  E061  spa_sync -> dsl_pool_sync
11  E062  dsl_pool_sync -> sync_task
12  E063  sync_task -> recv_begin_sync
13  E064  recv_begin_sync -> recv_ds  [target: new]  "created without an objset; it is built from the key nvlist's meta-dnode layout"
14  E065  recv_begin_sync -> recv_ds  [target: existing]  "a raw incremental needs an encrypted target"
15  E069  ioc_recv -> recv_stream
16  E070  recv_stream -> recv_crypt
17  E123  recv_crypt -> sync_task  "a sync task of its own, synced the same way as steps 7 to 10"
18  E075  recv_stream -> recv_writer
19  E072  recv_stream -> recv_cksum
20  E047  stream_fd -> recv_cksum
21  E073  recv_cksum -> recv_stream
22  E082  recv_writer -> recv_objrange
23  E084  recv_objrange -> recv_object
24  E078  recv_writer -> recv_object
25  E085  recv_object -> dmu_tx
26  E086  recv_object -> dmu_object
27  E087  dmu_object -> dnode
28  E088  recv_object -> dbuf_dirty  "the bonus area is copied still encrypted"
29  E080  recv_writer -> recv_write
30  E090  recv_write -> dmu_tx
31  E093  recv_write -> dmu_write
32  E098  dmu_write -> dbuf_dirty
33  E072  recv_stream -> recv_cksum
34  E073  recv_cksum -> recv_stream
35  E108  recv_writer -> recv_stream
36  E109  ioc_recv -> recv_end
37  E110  recv_end -> sync_task
38  E059  sync_task -> txg_sync
39  E060  txg_sync -> spa_sync
40  E061  spa_sync -> dsl_pool_sync
41  E106  dsl_pool_sync -> dbuf_sync
42  E107  dbuf_sync -> zio_create  "ZIO_FLAG_RAW: the ciphertext and its MAC are written without encrypting again"
43  E062  dsl_pool_sync -> sync_task
44  E111  sync_task -> recv_end_sync
45  E115  recv_end_sync -> recv_crypt  [target: existing]
46  E113  recv_end_sync -> recv_ds  [target: existing]
47  E112  recv_end_sync -> recv_ds  [target: new]
48  E116  recv_end -> ioc_recv
```
Ends: The dataset holds the sender's ciphertext and wrapped keys. It can be sent on raw, or mounted after zfs load-key with the sender's passphrase or key.

### 10.10 `interrupted_recv` - Interrupted resumable receive (zfs receive -s) and its resume

Category: Receive. With -s the receive saves its position in every txg. When the stream breaks, the inconsistent dataset is kept and publishes a resume token; the resumed stream from zfs send -t is checked against the saved state and continues where the data on disk ends.

```
 1  E125  admin -> zfs_recv_cmd
 2  E046  stream_fd -> zfs_recv_cmd
 3  E050  zfs_recv_cmd -> libzfs_recv  "-s"
 4  E051  libzfs_recv -> lzc_recv
 5  E055  lzc_recv -> ioc_recv  "a resumable receive always uses ZFS_IOC_RECV_NEW"
 6  E056  ioc_recv -> recv_begin
 7  E057  recv_begin -> sync_task
 8  E059  sync_task -> txg_sync
 9  E060  txg_sync -> spa_sync
10  E061  spa_sync -> dsl_pool_sync
11  E062  dsl_pool_sync -> sync_task
12  E063  sync_task -> recv_begin_sync
13  E064  recv_begin_sync -> recv_ds  "a full stream into a new dataset; an incremental one would use tofs/%recv"
14  E066  recv_begin_sync -> recv_ds
15  E069  ioc_recv -> recv_stream
16  E075  recv_stream -> recv_writer
17  E072  recv_stream -> recv_cksum
18  E047  stream_fd -> recv_cksum
19  E073  recv_cksum -> recv_stream
20  E078  recv_writer -> recv_object
21  E085  recv_object -> dmu_tx
22  E089  recv_object -> recv_resume_state
23  E080  recv_writer -> recv_write
24  E090  recv_write -> dmu_tx
25  E091  recv_write -> dmu_write
26  E098  dmu_write -> dbuf_dirty
27  E095  recv_write -> recv_resume_state
28  E105  recv_resume_state -> dsl_pool_sync
29  E072  recv_stream -> recv_cksum  "the connection breaks in the middle of a record"
30  E047  stream_fd -> recv_cksum
31  E074  recv_cksum -> recv_stream
32  E108  recv_writer -> recv_stream  "the writer applies what it already has and stops"
33  E117  recv_stream -> recv_cleanup
34  E118  recv_cleanup -> txg_sync
35  E119  recv_cleanup -> recv_ds
36  E048  recv_ds -> resume_token  "zfs get receive_resume_token on the target"
37  E049  resume_token -> zfs_send_cmd  "the sender continues with path resume_send"
38  E046  stream_fd -> zfs_recv_cmd  "the resumed stream arrives; zfs receive -s again"
39  E050  zfs_recv_cmd -> libzfs_recv
40  E051  libzfs_recv -> lzc_recv
41  E055  lzc_recv -> ioc_recv
42  E056  ioc_recv -> recv_begin
43  E058  recv_begin -> sync_task
44  E059  sync_task -> txg_sync
45  E060  txg_sync -> spa_sync
46  E061  spa_sync -> dsl_pool_sync
47  E062  dsl_pool_sync -> sync_task
48  E063  sync_task -> recv_begin_sync
49  E067  recv_begin_sync -> recv_ds
50  E069  ioc_recv -> recv_stream
51  E071  recv_stream -> recv_ds
52  E075  recv_stream -> recv_writer
53  E072  recv_stream -> recv_cksum
54  E047  stream_fd -> recv_cksum
55  E073  recv_cksum -> recv_stream  "the byte count continues from the saved DS_FIELD_RESUME_BYTES"
56  E080  recv_writer -> recv_write  "the first WRITE is the one applied last before the break; writing it again is harmless"
57  E090  recv_write -> dmu_tx
58  E091  recv_write -> dmu_write
59  E098  dmu_write -> dbuf_dirty
60  E072  recv_stream -> recv_cksum
61  E073  recv_cksum -> recv_stream
62  E108  recv_writer -> recv_stream
63  E109  ioc_recv -> recv_end
64  E110  recv_end -> sync_task
65  E059  sync_task -> txg_sync
66  E060  txg_sync -> spa_sync
67  E061  spa_sync -> dsl_pool_sync
68  E062  dsl_pool_sync -> sync_task
69  E111  sync_task -> recv_end_sync
70  E112  recv_end_sync -> recv_ds  "the resume entries are removed with the inconsistent flag"
71  E116  recv_end -> ioc_recv
```
Ends: The dataset and its snapshot are complete, exactly as if the first stream had not been interrupted. Without -s the first failure would have destroyed everything received.

### 10.11 `heal_recv` - Corrective receive (zfs receive -c)

Category: Receive. A stream of a snapshot is used to repair blocks of that same snapshot that fail their checksum, for example when no redundant copy is left. Nothing new is created; the damaged blocks are rewritten in place.

```
 1  E125  admin -> zfs_recv_cmd
 2  E046  stream_fd -> zfs_recv_cmd
 3  E050  zfs_recv_cmd -> libzfs_recv  "-c"
 4  E052  libzfs_recv -> lzc_recv
 5  E055  lzc_recv -> ioc_recv
 6  E056  ioc_recv -> recv_begin
 7  E057  recv_begin -> sync_task  "check: the snapshot must exist and, unless zfs_recv_best_effort_corrective is set, have the stream's toguid; -F is refused"
 8  E059  sync_task -> txg_sync
 9  E060  txg_sync -> spa_sync
10  E061  spa_sync -> dsl_pool_sync
11  E062  dsl_pool_sync -> sync_task
12  E063  sync_task -> recv_begin_sync
13  E068  recv_begin_sync -> recv_ds
14  E069  ioc_recv -> recv_stream
15  E075  recv_stream -> recv_writer
16  E072  recv_stream -> recv_cksum
17  E047  stream_fd -> recv_cksum
18  E073  recv_cksum -> recv_stream
19  E083  recv_writer -> recv_heal
20  E120  recv_heal -> arc_read  "a healthy block is left alone"
21  E121  recv_heal -> zio_create
22  E122  zio_create -> recv_heal
23  E072  recv_stream -> recv_cksum
24  E073  recv_cksum -> recv_stream
25  E108  recv_writer -> recv_stream
26  E109  ioc_recv -> recv_end
27  E110  recv_end -> sync_task
28  E059  sync_task -> txg_sync
29  E060  txg_sync -> spa_sync
30  E061  spa_sync -> dsl_pool_sync
31  E062  dsl_pool_sync -> sync_task
32  E111  sync_task -> recv_end_sync  "nothing to swap or snapshot: the blocks were repaired in place"
33  E116  recv_end -> ioc_recv
```
Ends: Every damaged block the stream could reproduce exactly has been rewritten and removed from the error log; zpool status no longer lists it once a scrub confirms.

## 11. Accuracy rules and known simplifications

Rules: as in section 11 of `../zfs-io-flow-diagram-spec.md`. OS-specific pieces use Linux names (lzc_send_wrapper's pipe, zfs_suspend_fs), which have FreeBSD equivalents.

Simplifications made on purpose. State these in the page's About overlay so nobody mistakes the diagram for the whole truth:

1. One send range and one record of each kind is drawn per path. Real streams interleave many OBJECT, FREEOBJECTS, WRITE and FREE records in (object, offset) order, each object's OBJECT record before its data.
2. Redacted sends (zfs redact, --redact, sends from redaction bookmarks) are reduced to the redaction-list node; the merge rules and the REDACT handling on receive are only described.
3. Spill blocks, large dnodes, byteswapped streams, zvol device nodes and the receive of a full stream as a clone are mentioned in node roles but not drawn as separate steps. DRR_WRITE_BYREF (deduplicated streams) is no longer generated, and the receiver rejects it.
4. Properties (-p, -o, -x, received properties), holds, saved sends (-S), dry runs and size estimates, progress reporting and zfs receive -A are left out except where a label names them.
5. The receive writer's deferral of reallocated dnodes (receive_defer_*) is described in receive_object's role but not drawn. The reset of user accounting after a raw receive is not drawn.
6. Sync tasks are shown going through txg_sync, spa_sync and dsl_pool_sync like the rest of a txg. Below dbuf_sync the write pipeline (compression, checksums, allocation, vdevs) is in the I/O graph, path txg_sync.
7. Corrective receive reads the block through dbuf_read(); the diagram draws that as one wire to arc_read.

## 12. Build order

See `../zfs-io-flow-diagram-spec.md` section 12 and `zfs-viewer-suite-spec.md`.

## 13. Acceptance checklist

- Counts: 57 nodes, 125 wires, 11 paths, 430 path steps, 9 groups, 8 wire types, 165 functions in the index, 270 wire references (Appendix C), 14 tunable and property references (Appendix D).
- Activating path `full_send` with the default alternatives highlights 27 distinct wires and plays 31 steps; `incr_recv` highlights 42 and plays 48; `interrupted_recv` highlights 43 and plays 71.
- Node `sync_task` lists 5 incoming and 3 outgoing wires. Node `recv_ds` lists 10 incoming and 1 outgoing wires.
- Switching `full_send` to `block: embedded` drops the read steps and plays E039 instead of E035; `cache: hit` plays E030 instead of E028 and E031.
- Searching `fromtxg` finds wires E015, E018 and E023. Searching `receive_resume_token` finds node `resume_token`.
- Shared nodes (`arc_read`, `zio_create`, `dmu_tx`, `dmu_write`, `dbuf_dirty`, `dnode`, `zfetch`, `txg_sync`, `spa_sync`, `dsl_pool_sync`, `dbuf_sync`) show "Also in: ZFS I/O Flow".

## Appendix A. Function index

Functions named in section 8, with file and line at commit `c913da8615`.

```
arc_getbuf_func  module/zfs/arc.c:5577
arc_read  module/zfs/arc.c:5905
corrective_read_done  module/zfs/dmu_recv.c:1487
create_begin_record  module/zfs/dmu_send.c:2083
dbuf_assign_arcbuf  module/zfs/dbuf.c:3290
dbuf_dirty  module/zfs/dbuf.c:2369
dbuf_dirty_lightweight  module/zfs/dbuf.c:2289
dbuf_lightweight_ready  module/zfs/dbuf.c:4755
dbuf_prefetch_impl  module/zfs/dbuf.c:3887
dbuf_sync_lightweight  module/zfs/dbuf.c:4822
dmu_buf_will_dirty  module/zfs/dbuf.c:2819
dmu_buf_write_embedded  module/zfs/dbuf.c:3210
dmu_dump_write  module/zfs/dmu_send.c:445
dmu_free_long_range  module/zfs/dmu.c:1297
dmu_free_long_range_impl  module/zfs/dmu.c:1193
dmu_lightweight_write_by_dnode  module/zfs/dmu.c:1964
dmu_object_claim_dnsize  module/zfs/dmu_object.c:264
dmu_object_free  module/zfs/dmu_object.c:351
dmu_object_reclaim_dnsize  module/zfs/dmu_object.c:302
dmu_prefetch  module/zfs/dmu.c:726
dmu_recv_begin  module/zfs/dmu_recv.c:1336
dmu_recv_begin_check  module/zfs/dmu_recv.c:666
dmu_recv_begin_sync  module/zfs/dmu_recv.c:882
dmu_recv_cleanup_ds  module/zfs/dmu_recv.c:4355
dmu_recv_end  module/zfs/dmu_recv.c:5731
dmu_recv_end_check  module/zfs/dmu_recv.c:5456
dmu_recv_end_sync  module/zfs/dmu_recv.c:5535
dmu_recv_existing_end  module/zfs/dmu_recv.c:5705
dmu_recv_new_end  module/zfs/dmu_recv.c:5723
dmu_recv_resume_begin_check  module/zfs/dmu_recv.c:1115
dmu_recv_resume_begin_sync  module/zfs/dmu_recv.c:1290
dmu_recv_stream  module/zfs/dmu_recv.c:5210
dmu_send  module/zfs/dmu_send.c:2836
dmu_send_impl  module/zfs/dmu_send.c:2449
dmu_send_obj  module/zfs/dmu_send.c:2746
dmu_send_read_done  module/zfs/dmu_send.c:1605
dmu_tx_assign  module/zfs/dmu_tx.c:1239
dmu_tx_commit  module/zfs/dmu_tx.c:1454
dmu_tx_create  module/zfs/dmu_tx.c:73
dmu_tx_hold_write_by_dnode  module/zfs/dmu_tx.c:366
dmu_write_by_dnode  module/zfs/dmu.c:1510
dmu_write_embedded  module/zfs/dmu.c:1538
dnode_allocate  module/zfs/dnode.c:712
dnode_free_range  module/zfs/dnode.c:2245
dnode_hold_impl  module/zfs/dnode.c:1432
dnode_reallocate  module/zfs/dnode.c:805
dnode_setdirty  module/zfs/dnode.c:1846
do_corrective_recv  module/zfs/dmu_recv.c:1538
do_dump  module/zfs/dmu_send.c:888
dsl_bookmark_lookup  module/zfs/dsl_bookmark.c:101
dsl_crypto_recv_raw  module/zfs/dsl_crypt.c:2573
dsl_crypto_recv_raw_key_sync  module/zfs/dsl_crypt.c:2394
dsl_crypto_recv_raw_objset_sync  module/zfs/dsl_crypt.c:2221
dsl_dataset_clone_swap_sync_impl  module/zfs/dsl_dataset.c:4338
dsl_dataset_create_sync  module/zfs/dsl_dataset.c:1326
dsl_dataset_has_resume_receive_state  module/zfs/dsl_dataset.c:5185
dsl_dataset_is_before  module/zfs/dsl_dataset.c:5124
dsl_dataset_snapshot_sync_impl  module/zfs/dsl_dataset.c:1736
dsl_dataset_sync  module/zfs/dsl_dataset.c:2133
dsl_destroy_head_sync_impl  module/zfs/dsl_destroy.c:1064
dsl_destroy_snapshot_sync_impl  module/zfs/dsl_destroy.c:307
dsl_pool_sync  module/zfs/dsl_pool.c:700
dsl_sync_task  module/zfs/dsl_synctask.c:126
dsl_sync_task_common  module/zfs/dsl_synctask.c:34
dsl_sync_task_sync  module/zfs/dsl_synctask.c:207
dump_bytes  module/zfs/zfs_ioctl.c:6312
dump_bytes_init  module/zfs/zfs_ioctl.c:6333
dump_dnode  module/zfs/dmu_send.c:700
dump_filesystems  lib/libzfs/libzfs_sendrecv.c:1421
dump_free  module/zfs/dmu_send.c:318
dump_freeobjects  module/zfs/dmu_send.c:637
dump_ioctl  lib/libzfs/libzfs_sendrecv.c:823
dump_object_range  module/zfs/dmu_send.c:795
dump_record  module/zfs/dmu_send.c:250
dump_redact  module/zfs/dmu_send.c:398
dump_snapshot  lib/libzfs/libzfs_sendrecv.c:1149
dump_spill  module/zfs/dmu_send.c:592
dump_write_embedded  module/zfs/dmu_send.c:552
find_next_range  module/zfs/dmu_send.c:1419
flush_write_batch  module/zfs/dmu_recv.c:3947
flush_write_batch_impl  module/zfs/dmu_recv.c:3768
get_receive_resume_token  module/zfs/dsl_dataset.c:2609
get_receive_resume_token_impl  module/zfs/dsl_dataset.c:2488
issue_data_read  module/zfs/dmu_send.c:1623
lzc_flags_from_sendflags  lib/libzfs/libzfs_sendrecv.c:1600
lzc_receive_with_cmdprops  lib/libzfs_core/libzfs_core.c:1420
lzc_receive_with_heal  lib/libzfs_core/libzfs_core.c:1440
lzc_send_redacted  lib/libzfs_core/libzfs_core.c:850
lzc_send_resume_redacted  lib/libzfs_core/libzfs_core.c:932
lzc_send_resume_redacted_cb_impl  lib/libzfs_core/libzfs_core.c:880
lzc_send_wrapper  lib/libzfs_core/libzfs_core.c:764
piggyback_unmodified_spill  module/zfs/dmu_send.c:1766
receive_cksum  module/zfs/dmu_recv.c:4387
receive_defer_flush  module/zfs/dmu_recv.c:2955
receive_defer_free_object  module/zfs/dmu_recv.c:2816
receive_defer_park  module/zfs/dmu_recv.c:2915
receive_free  module/zfs/dmu_recv.c:4265
receive_freeobjects  module/zfs/dmu_recv.c:3716
receive_handle_existing_object  module/zfs/dmu_recv.c:3152
receive_object  module/zfs/dmu_recv.c:3398
receive_object_range  module/zfs/dmu_recv.c:4286
receive_process_record  module/zfs/dmu_recv.c:4816
receive_process_write_record  module/zfs/dmu_recv.c:3966
receive_read  module/zfs/dmu_recv.c:1734
receive_read_payload_and_next_header  module/zfs/dmu_recv.c:4405
receive_read_prefetch  module/zfs/dmu_recv.c:4492
receive_read_record  module/zfs/dmu_recv.c:4505
receive_redact  module/zfs/dmu_recv.c:4343
receive_spill  module/zfs/dmu_recv.c:4171
receive_write_embedded  module/zfs/dmu_recv.c:4065
receive_writer_thread  module/zfs/dmu_recv.c:5107
recv_begin_check_existing_impl  module/zfs/dmu_recv.c:386
recv_destroy  lib/libzfs/libzfs_sendrecv.c:3128
recv_impl  lib/libzfs_core/libzfs_core.c:1111
recv_incremental_replication  lib/libzfs/libzfs_sendrecv.c:3557
redact_list_cb  module/zfs/dmu_send.c:1187
redact_list_thread  module/zfs/dmu_send.c:1316
resume_check  module/zfs/dmu_recv.c:5169
resume_skip_check  module/zfs/dmu_traverse.c:163
save_resume_state  module/zfs/dmu_recv.c:1789
send_cb  module/zfs/dmu_send.c:1082
send_conclusion_record  lib/libzfs/libzfs_sendrecv.c:2177
send_do_embed  module/zfs/dmu_send.c:830
send_merge_thread  module/zfs/dmu_send.c:1523
send_prelim_records  lib/libzfs/libzfs_sendrecv.c:2201
send_reader_thread  module/zfs/dmu_send.c:1800
send_traverse_thread  module/zfs/dmu_send.c:1215
setup_featureflags  module/zfs/dmu_send.c:2001
setup_from_thread  module/zfs/dmu_send.c:2154
setup_merge_thread  module/zfs/dmu_send.c:2194
setup_reader_thread  module/zfs/dmu_send.c:2215
setup_redact_list_thread  module/zfs/dmu_send.c:2174
setup_resume_points  module/zfs/dmu_send.c:2230
setup_to_thread  module/zfs/dmu_send.c:2125
spa_sync  module/zfs/spa.c:11405
spa_sync_iterate_to_convergence  module/zfs/spa.c:11192
traverse_dataset_resume  module/zfs/dmu_traverse.c:732
traverse_impl  module/zfs/dmu_traverse.c:629
traverse_prefetch_metadata  module/zfs/dmu_traverse.c:186
traverse_visitbp  module/zfs/dmu_traverse.c:226
txg_sync_thread  module/zfs/txg.c:510
txg_wait_synced  module/zfs/txg.c:764
zfs_do_receive  cmd/zfs/zfs_main.c:5165
zfs_do_send  cmd/zfs/zfs_main.c:4753
zfs_ioc_recv  module/zfs/zfs_ioctl.c:6091
zfs_ioc_recv_impl  module/zfs/zfs_ioctl.c:5740
zfs_ioc_recv_new  module/zfs/zfs_ioctl.c:6198
zfs_ioc_send  module/zfs/zfs_ioctl.c:6380
zfs_ioc_send_new  module/zfs/zfs_ioctl.c:7403
zfs_receive  lib/libzfs/libzfs_sendrecv.c:5672
zfs_receive_impl  lib/libzfs/libzfs_sendrecv.c:5528
zfs_receive_one  lib/libzfs/libzfs_sendrecv.c:4464
zfs_receive_package  lib/libzfs/libzfs_sendrecv.c:3868
zfs_send  lib/libzfs/libzfs_sendrecv.c:2564
zfs_send_cb_impl  lib/libzfs/libzfs_sendrecv.c:2341
zfs_send_one  lib/libzfs/libzfs_sendrecv.c:2870
zfs_send_one_cb_impl  lib/libzfs/libzfs_sendrecv.c:2661
zfs_send_resume  lib/libzfs/libzfs_sendrecv.c:2057
zfs_send_resume_impl_cb_impl  lib/libzfs/libzfs_sendrecv.c:1820
zfs_send_resume_token_to_nvlist  lib/libzfs/libzfs_sendrecv.c:1523
zio_nowait  module/zfs/zio.c:2890
zio_read  module/zfs/zio.c:1345
zio_rewrite  module/zfs/zio.c:1398
zio_wait  module/zfs/zio.c:2841
zio_write  module/zfs/zio.c:1361
```

## Appendix C. Wire source references

Each line is `<wire>  <file>:<line>  <symbol>`, and the symbol appears verbatim on that source line. A wire's references are listed in the order of the calls in its label.

```
E001  cmd/zfs/zfs_main.c:5065  zfs_send_one
E002  cmd/zfs/zfs_main.c:5013  zfs_send_resume
E002  lib/libzfs/libzfs_sendrecv.c:2067  zfs_send_resume_token_to_nvlist
E003  cmd/zfs/zfs_main.c:5141  zfs_send
E004  lib/libzfs/libzfs_sendrecv.c:2788  lzc_send_redacted
E004  lib/libzfs/libzfs_sendrecv.c:2789  lzc_flags_from_sendflags
E005  lib/libzfs/libzfs_sendrecv.c:1860  guid_to_name
E005  lib/libzfs/libzfs_sendrecv.c:1969  lzc_send_resume_redacted
E006  lib/libzfs/libzfs_sendrecv.c:2879  lzc_send_wrapper
E006  lib/libzfs_core/libzfs_core.c:779  pipe2
E006  lib/libzfs_core/libzfs_core.c:908  ZFS_IOC_SEND_NEW
E007  lib/libzfs/libzfs_sendrecv.c:2395  send_prelim_records
E007  lib/libzfs/libzfs_sendrecv.c:2290  DMU_COMPOUNDSTREAM
E007  lib/libzfs/libzfs_sendrecv.c:2308  send_conclusion_record
E008  lib/libzfs/libzfs_sendrecv.c:2506  dump_filesystems
E008  lib/libzfs/libzfs_sendrecv.c:1359  dump_snapshot
E008  lib/libzfs/libzfs_sendrecv.c:1283  dump_ioctl
E008  lib/libzfs/libzfs_sendrecv.c:847  ZFS_IOC_SEND
E009  lib/libzfs/libzfs_sendrecv.c:2526  send_conclusion_record
E009  lib/libzfs/libzfs_sendrecv.c:2181  DRR_END
E010  module/zfs/zfs_ioctl.c:7436  dump_bytes_init
E010  module/zfs/zfs_ioctl.c:6346  dump_bytes
E010  module/zfs/zfs_ioctl.c:7441  dmu_send
E011  module/zfs/zfs_ioctl.c:6453  dmu_send_obj
E012  module/zfs/dmu_send.c:2925  dsl_dataset_hold_flags
E012  module/zfs/dmu_send.c:3051  dmu_send_impl
E013  module/zfs/dmu_send.c:2978  dsl_dataset_hold
E013  module/zfs/dmu_send.c:3005  dsl_dataset_is_before
E013  module/zfs/dmu_send.c:3009  zbm_creation_txg
E014  module/zfs/dmu_send.c:3031  dsl_bookmark_lookup
E014  module/zfs/dsl_bookmark.c:114  dsl_dataset_is_before
E015  module/zfs/dmu_send.c:3041  dmu_send_impl
E015  module/zfs/dmu_send.c:2456  zbm_creation_txg
E016  module/zfs/dmu_send.c:2502  setup_featureflags
E016  module/zfs/dmu_send.c:2547  create_begin_record
E016  module/zfs/dmu_send.c:2644  dump_record
E017  module/zfs/dmu_send.c:2625  dsl_crypto_populate_key_nvlist
E017  module/zfs/dmu_send.c:2632  crypt_keydata
E018  module/zfs/dmu_send.c:2651  setup_to_thread
E018  module/zfs/dmu_send.c:2149  send_traverse_thread
E018  module/zfs/dmu_send.c:2137  TRAVERSE_NO_DECRYPT
E018  module/zfs/dmu_send.c:2147  TRAVERSE_HARD
E019  module/zfs/dmu_send.c:2652  setup_from_thread
E019  module/zfs/dmu_send.c:2653  setup_redact_list_thread
E019  module/zfs/dmu_send.c:2654  setup_merge_thread
E019  module/zfs/dmu_send.c:2655  setup_reader_thread
E020  module/zfs/dmu_send.c:2614  setup_resume_points
E020  module/zfs/dmu_send.c:2259  SET_BOOKMARK
E020  module/zfs/dmu_send.c:2280  BEGINNV_RESUME_OBJECT
E021  module/zfs/dmu_send.c:1222  traverse_dataset_resume
E021  module/zfs/dmu_traverse.c:708  traverse_visitbp
E022  module/zfs/dmu_traverse.c:312  arc_read
E022  module/zfs/dmu_traverse.c:347  traverse_prefetch_metadata
E023  module/zfs/dmu_traverse.c:272  td_min_txg
E023  module/zfs/dmu_traverse.c:295  td_func
E024  module/zfs/dmu_send.c:1159  range_alloc
E024  module/zfs/dmu_send.c:1175  bqueue_enqueue
E024  module/zfs/dmu_send.c:1229  bqueue_enqueue_flush
E025  module/zfs/dmu_send.c:1327  dsl_redaction_list_traverse
E025  module/zfs/dmu_send.c:1333  bqueue_enqueue_flush
E026  module/zfs/dmu_send.c:1548  find_next_range
E026  module/zfs/dmu_send.c:1562  bqueue_enqueue
E027  module/zfs/dmu_send.c:1684  arc_read
E027  module/zfs/dmu_send.c:1682  ARC_FLAG_CACHED_ONLY
E027  module/zfs/dmu_send.c:1661  ZIO_FLAG_RAW_COMPRESS
E027  module/zfs/dmu_send.c:1658  ZIO_FLAG_RAW
E028  module/zfs/dmu_send.c:1709  zio_read
E028  module/zfs/dmu_send.c:1710  dmu_send_read_done
E029  module/zfs/dmu_send.c:1827  bqueue_enqueue
E029  module/zfs/dmu_send.c:2657  bqueue_dequeue
E030  module/zfs/dmu_send.c:1685  arc_getbuf_func
E031  module/zfs/dmu_send.c:1618  cv_broadcast
E031  module/zfs/dmu_send.c:942  cv_wait
E032  module/zfs/dmu_send.c:893  dump_dnode
E032  module/zfs/dmu_send.c:1027  dump_freeobjects
E033  module/zfs/dmu_send.c:907  dump_object_range
E034  module/zfs/dmu_send.c:784  dump_free
E035  module/zfs/dmu_send.c:1014  dmu_dump_write
E036  module/zfs/dmu_send.c:1014  dmu_dump_write
E036  module/zfs/dmu_send.c:520  drr_compressed_size
E037  module/zfs/dmu_send.c:1014  dmu_dump_write
E037  module/zfs/dmu_send.c:505  zio_crypt_decode_params_bp
E037  module/zfs/dmu_send.c:507  zio_crypt_decode_mac_bp
E038  module/zfs/dmu_send.c:988  SPA_OLD_MAXBLOCKSIZE
E038  module/zfs/dmu_send.c:998  dmu_dump_write
E039  module/zfs/dmu_send.c:927  send_do_embed
E039  module/zfs/dmu_send.c:928  dump_write_embedded
E040  module/zfs/dmu_send.c:1045  dump_free
E041  module/zfs/dmu_send.c:780  dump_record
E042  module/zfs/dmu_send.c:546  dump_record
E043  module/zfs/dmu_send.c:383  DMU_OBJECT_END
E043  module/zfs/dmu_send.c:384  dump_record
E044  module/zfs/dmu_send.c:255  fletcher_4_incremental_native
E044  module/zfs/dmu_send.c:272  dso_outfunc
E044  module/zfs/zfs_ioctl.c:6300  zfs_file_write
E045  module/zfs/dmu_send.c:2709  DRR_END
E045  module/zfs/dmu_send.c:2710  dsc_zc
E046  cmd/zfs/zfs_main.c:5308  isatty
E047  module/zfs/dmu_recv.c:1748  zfs_file_read
E048  module/zfs/dsl_dataset.c:2982  get_receive_resume_token
E048  module/zfs/dsl_dataset.c:2630  get_receive_resume_token_impl
E048  module/zfs/dsl_dataset.c:2578  zfs_gzip_compress
E048  module/zfs/dsl_dataset.c:2584  fletcher_4_native_varsize
E049  cmd/zfs/zfs_main.c:4862  resume_token
E050  cmd/zfs/zfs_main.c:5316  zfs_receive
E051  lib/libzfs/libzfs_sendrecv.c:5562  recv_read
E051  lib/libzfs/libzfs_sendrecv.c:5653  zfs_receive_one
E051  lib/libzfs/libzfs_sendrecv.c:5095  lzc_receive_with_cmdprops
E052  lib/libzfs/libzfs_sendrecv.c:5090  lzc_receive_with_heal
E053  lib/libzfs/libzfs_sendrecv.c:5659  zfs_receive_package
E053  lib/libzfs/libzfs_sendrecv.c:3898  recv_read_nvlist
E054  lib/libzfs/libzfs_sendrecv.c:3989  recv_incremental_replication
E054  lib/libzfs/libzfs_sendrecv.c:3696  recv_destroy
E054  lib/libzfs/libzfs_sendrecv.c:4044  zfs_receive_impl
E055  lib/libzfs_core/libzfs_core.c:1197  begin_record
E055  lib/libzfs_core/libzfs_core.c:1200  input_fd
E055  lib/libzfs_core/libzfs_core.c:1211  ZFS_IOC_RECV_NEW
E055  lib/libzfs_core/libzfs_core.c:1279  ZFS_IOC_RECV
E056  module/zfs/zfs_ioctl.c:6258  zfs_ioc_recv_impl
E056  module/zfs/zfs_ioctl.c:5764  zfs_file_get
E056  module/zfs/zfs_ioctl.c:5768  dmu_recv_begin
E057  module/zfs/dmu_recv.c:1365  fletcher_4_incremental_native
E057  module/zfs/dmu_recv.c:1461  dsl_sync_task
E057  module/zfs/dmu_recv.c:1462  dmu_recv_begin_check
E058  module/zfs/dmu_recv.c:1439  dsl_sync_task
E058  module/zfs/dmu_recv.c:1440  dmu_recv_resume_begin_check
E059  module/zfs/dsl_synctask.c:64  dst_checkfunc
E059  module/zfs/dsl_synctask.c:75  txg_list_add_tail
E059  module/zfs/dsl_synctask.c:91  txg_wait_synced
E060  module/zfs/txg.c:602  spa_sync
E061  module/zfs/spa.c:11502  spa_sync_iterate_to_convergence
E061  module/zfs/spa.c:11208  dsl_pool_sync
E062  module/zfs/dsl_pool.c:876  dsl_sync_task_sync
E063  module/zfs/dsl_synctask.c:244  dst_checkfunc
E063  module/zfs/dsl_synctask.c:246  dst_syncfunc
E064  module/zfs/dmu_recv.c:956  dsl_dataset_create_sync
E064  module/zfs/dmu_recv.c:1045  DS_FLAG_INCONSISTENT
E065  module/zfs/dmu_recv.c:732  recv_begin_check_existing_impl
E065  module/zfs/dmu_recv.c:502  fromguid
E065  module/zfs/dmu_recv.c:935  dsl_dataset_create_sync
E065  module/zfs/dmu_recv.c:1045  DS_FLAG_INCONSISTENT
E066  module/zfs/dmu_recv.c:979  dsl_dataset_zapify
E066  module/zfs/dmu_recv.c:984  DS_FIELD_RESUME_TOGUID
E067  module/zfs/dmu_recv.c:1310  dsl_dataset_own_force
E067  module/zfs/dmu_recv.c:1190  drr_toguid
E068  module/zfs/dmu_recv.c:932  dsl_dataset_snap_lookup
E069  module/zfs/zfs_ioctl.c:5846  zfs_set_prop_nvlist
E069  module/zfs/zfs_ioctl.c:5884  dmu_recv_stream
E070  module/zfs/dmu_recv.c:5259  dsl_crypto_recv_raw
E071  module/zfs/dmu_recv.c:5276  resume_check
E071  module/zfs/dmu_recv.c:5184  DS_FIELD_RESUME_OBJECT
E072  module/zfs/dmu_recv.c:5353  receive_read_record
E072  module/zfs/dmu_recv.c:4573  recv_check_drr_write
E072  module/zfs/dmu_recv.c:4585  receive_read_payload_and_next_header
E073  module/zfs/dmu_recv.c:4414  receive_cksum
E073  module/zfs/dmu_recv.c:4463  ZIO_CHECKSUM_EQUAL
E073  module/zfs/dmu_recv.c:4648  drc_prev_cksum
E074  module/zfs/dmu_recv.c:1756  ZFS_ERR_STREAM_TRUNCATED
E074  module/zfs/dmu_recv.c:4466  ECKSUM
E075  module/zfs/dmu_recv.c:5326  receive_writer_thread
E075  module/zfs/dmu_recv.c:5361  bqueue_enqueue
E076  module/zfs/dmu_recv.c:4592  receive_read_prefetch
E076  module/zfs/dmu_recv.c:4496  dmu_prefetch
E077  module/zfs/dmu.c:739  dmu_prefetch_by_dnode
E077  module/zfs/dmu.c:878  dbuf_prefetch_impl
E077  module/zfs/dbuf.c:4002  arc_read
E078  module/zfs/dmu_recv.c:5122  receive_process_record
E078  module/zfs/dmu_recv.c:4873  receive_object
E079  module/zfs/dmu_recv.c:4892  receive_freeobjects
E079  module/zfs/dmu_recv.c:4929  receive_free
E080  module/zfs/dmu_recv.c:4897  receive_process_write_record
E080  module/zfs/dmu_recv.c:4854  flush_write_batch
E081  module/zfs/dmu_recv.c:4921  receive_write_embedded
E081  module/zfs/dmu_recv.c:4935  receive_spill
E082  module/zfs/dmu_recv.c:4946  receive_object_range
E083  module/zfs/dmu_recv.c:4832  DRR_WRITE
E083  module/zfs/dmu_recv.c:4897  receive_process_write_record
E084  module/zfs/dmu_recv.c:4325  or_crypt_params_present
E084  module/zfs/dmu_recv.c:3635  dmu_buf_set_crypt_params
E085  module/zfs/dmu_recv.c:3570  dmu_tx_create
E085  module/zfs/dmu_recv.c:3571  dmu_tx_hold_bonus
E085  module/zfs/dmu_recv.c:3572  dmu_tx_hold_write
E085  module/zfs/dmu_recv.c:3573  dmu_tx_assign
E086  module/zfs/dmu_recv.c:3581  dmu_object_claim_dnsize
E086  module/zfs/dmu_recv.c:3590  dmu_object_reclaim_dnsize
E087  module/zfs/dmu_object.c:280  dnode_hold_impl
E087  module/zfs/dmu_object.c:285  dnode_allocate
E087  module/zfs/dmu_object.c:321  dnode_reallocate
E088  module/zfs/dmu_recv.c:3680  dmu_bonus_hold_by_dnode
E088  module/zfs/dmu_recv.c:3682  dmu_buf_will_dirty
E089  module/zfs/dmu_recv.c:3708  save_resume_state
E090  module/zfs/dmu_recv.c:3799  dmu_tx_hold_write_by_dnode
E090  module/zfs/dmu_recv.c:3801  dmu_tx_assign
E091  module/zfs/dmu_recv.c:3864  dmu_write_policy
E091  module/zfs/dmu_recv.c:3917  dmu_lightweight_write_by_dnode
E092  module/zfs/dmu_recv.c:3893  zp_compress
E092  module/zfs/dmu_recv.c:3894  ZIO_FLAG_RAW_COMPRESS
E092  module/zfs/dmu_recv.c:3917  dmu_lightweight_write_by_dnode
E093  module/zfs/dmu_recv.c:3869  zp_encrypt
E093  module/zfs/dmu_recv.c:3888  ZIO_FLAG_RAW
E093  module/zfs/dmu_recv.c:3917  dmu_lightweight_write_by_dnode
E094  module/zfs/dmu_recv.c:3844  dmu_write_by_dnode
E095  module/zfs/dmu_recv.c:3935  save_resume_state
E096  module/zfs/dmu_recv.c:4279  dmu_free_long_range
E096  module/zfs/dmu_recv.c:3750  receive_defer_free_object
E096  module/zfs/dmu_recv.c:2822  dmu_free_long_range
E096  module/zfs/dmu_recv.c:2832  dmu_object_free
E097  module/zfs/dmu.c:1306  dmu_free_long_range_impl
E097  module/zfs/dmu.c:1237  dmu_tx_hold_free
E097  module/zfs/dmu.c:1287  dnode_free_range
E098  module/zfs/dmu.c:1968  dbuf_dirty_lightweight
E099  module/zfs/dmu.c:1470  dmu_buf_will_fill_flags
E099  module/zfs/dmu.c:1478  dmu_buf_will_dirty_flags
E099  module/zfs/dmu.c:1482  memcpy
E100  module/zfs/dmu_recv.c:4157  dmu_write_embedded
E100  module/zfs/dmu_recv.c:4152  dmu_write_by_dnode
E101  module/zfs/dmu.c:1549  dmu_buf_write_embedded
E101  module/zfs/dbuf.c:3232  dmu_buf_will_not_fill
E102  module/zfs/dmu_recv.c:4241  arc_loan_buf
E102  module/zfs/dmu_recv.c:4235  arc_loan_raw_buf
E102  module/zfs/dmu_recv.c:4254  dbuf_assign_arcbuf
E103  module/zfs/dmu_recv.c:4140  dmu_tx_hold_write_by_dnode
E103  module/zfs/dmu_recv.c:4208  dmu_tx_hold_spill
E103  module/zfs/dmu_recv.c:4142  dmu_tx_assign
E104  module/zfs/dbuf.c:2331  dn_dirty_records
E104  module/zfs/dbuf.c:2334  dnode_setdirty
E105  module/zfs/dmu_recv.c:1844  ds_resume_object
E105  module/zfs/dsl_dataset.c:2146  ds_resume_bytes
E106  module/zfs/dsl_pool.c:744  dsl_dataset_sync
E106  module/zfs/dsl_dataset.c:2161  dmu_objset_sync
E106  module/zfs/dbuf.c:5048  dbuf_sync_lightweight
E107  module/zfs/dbuf.c:4845  zio_write
E108  module/zfs/dmu_recv.c:5152  receive_defer_flush
E108  module/zfs/dmu_recv.c:5155  flush_write_batch
E108  module/zfs/dmu_recv.c:5162  cv_signal
E109  module/zfs/zfs_ioctl.c:5899  zfs_suspend_fs
E109  module/zfs/zfs_ioctl.c:5918  zvol_suspend
E109  module/zfs/zfs_ioctl.c:5904  dmu_recv_end
E110  module/zfs/dmu_recv.c:5738  dmu_recv_new_end
E110  module/zfs/dmu_recv.c:5740  dmu_recv_existing_end
E110  module/zfs/dmu_recv.c:5725  dsl_sync_task
E111  module/zfs/dsl_synctask.c:244  dst_checkfunc
E111  module/zfs/dsl_synctask.c:246  dst_syncfunc
E112  module/zfs/dmu_recv.c:5620  dsl_dataset_snapshot_sync_impl
E112  module/zfs/dmu_recv.c:5625  ds_guid
E112  module/zfs/dmu_recv.c:5631  DS_FLAG_INCONSISTENT
E112  module/zfs/dmu_recv.c:5636  DS_FIELD_RESUME_OBJECT
E113  module/zfs/dmu_recv.c:5587  dsl_dataset_clone_swap_sync_impl
E113  module/zfs/dmu_recv.c:5595  dsl_dataset_snapshot_sync_impl
E113  module/zfs/dmu_recv.c:5600  ds_guid
E113  module/zfs/dmu_recv.c:5613  dsl_destroy_head_sync_impl
E114  module/zfs/dmu_recv.c:5572  dsl_destroy_snapshot_sync_impl
E115  module/zfs/dmu_recv.c:5578  dsl_crypto_recv_raw_key_sync
E116  module/zfs/zfs_ioctl.c:5914  zfs_resume_fs
E116  module/zfs/zfs_ioctl.c:5927  zfs_set_prop_nvlist
E117  module/zfs/dmu_recv.c:5443  dmu_recv_cleanup_ds
E117  module/zfs/dmu_recv.c:5743  dmu_recv_cleanup_ds
E118  module/zfs/dmu_recv.c:4368  txg_wait_synced
E119  module/zfs/dmu_recv.c:4375  dsl_dataset_disown
E119  module/zfs/dmu_recv.c:4382  dsl_destroy_head
E120  module/zfs/dmu_recv.c:3994  dmu_buf_hold_noread
E120  module/zfs/dmu_recv.c:4000  dbuf_read
E121  module/zfs/dmu_recv.c:4021  do_corrective_recv
E121  module/zfs/dmu_recv.c:1705  zio_checksum_compute
E121  module/zfs/dmu_recv.c:1697  zio_rewrite
E121  module/zfs/dmu_recv.c:1722  zio_read
E122  module/zfs/dmu_recv.c:1492  spa_remove_error
E123  module/zfs/dsl_crypt.c:2584  dsl_sync_task
E124  cmd/zfs/zfs_main.c:223  zfs_do_send
E125  cmd/zfs/zfs_main.c:224  zfs_do_receive
```

## Appendix D. Tunable and property source references

Same format as Appendix C, keyed by name. A tunable's symbol is the name part as written in its `ZFS_MODULE_PARAM` line; a property's symbol is its quoted name in `module/zcommon/zfs_prop.c`.

```
send_holes_without_birth_time  module/zfs/dmu_traverse.c:830  send_holes_without_birth_time
zfs_recv_best_effort_corrective  module/zfs/dmu_recv.c:5784  best_effort_corrective
zfs_recv_defer_batch_size  module/zfs/dmu_recv.c:5780  defer_batch_size
zfs_recv_queue_ff  module/zfs/dmu_recv.c:5774  queue_ff
zfs_recv_queue_length  module/zfs/dmu_recv.c:5771  queue_length
zfs_recv_write_batch_size  module/zfs/dmu_recv.c:5777  write_batch_size
zfs_send_corrupt_data  module/zfs/dmu_send.c:3209  corrupt_data
zfs_send_no_prefetch_queue_ff  module/zfs/dmu_send.c:3224  no_prefetch_queue_ff
zfs_send_no_prefetch_queue_length  module/zfs/dmu_send.c:3218  no_prefetch_queue_length
zfs_send_queue_ff  module/zfs/dmu_send.c:3221  queue_ff
zfs_send_queue_length  module/zfs/dmu_send.c:3212  queue_length
zfs_send_unmodified_spill_blocks  module/zfs/dmu_send.c:3215  unmodified_spill_blocks
zfs_traverse_indirect_prefetch_limit  module/zfs/dmu_traverse.c:827  traverse_indirect_prefetch_limit
receive_resume_token  module/zcommon/zfs_prop.c:610  "receive_resume_token"
```
