这个问题我需要补充一个边界：当前项目依赖 Liveblocks Tiptap 扩展提供的初始化机制，但严格来说，我没有自己实现一个服务端的分布式锁。

当前的初始化时机是在 `RoomProvider` 建立后，Tiptap Editor 和 Liveblocks Yjs Provider 已经准备好时触发。`useLiveblocksExtension` 会读取共享 Y.Doc 中的：

```ts
liveblocks_config.hasContentSet
```

如果这个标记不存在，才会执行：

```ts
ydoc.getMap("liveblocks_config").set("hasContentSet", true);
editor.commands.setContent(initialContent);
```

这个标记存储在共享 Y.Doc 中，而不是某个客户端的 React 状态，所以初始化完成后会同步给同一个 Room 的其他用户，后续客户端看到标记后就不会再次使用 Convex 的 `initialContent` 覆盖正文。

不过，如果题目要求在极端情况下也保证严格的一次性，比如两个客户端都还没有收到对方的标记，或者两端处于网络分区状态，那么仅靠这个共享标记并不是严格意义上的 compare-and-set，也不能完全等同于服务端锁。当前实现主要保证正常联网场景下的初始化不会重复。

如果要把这个边界做得更严谨，我会增加一层初始化状态控制：

1. 在 Convex 文档中增加 `initializationStatus`，初始为 `pending`。
2. 客户端先等待 Liveblocks Yjs 同步完成，并暂时将编辑器设为只读。
3. 通过 Convex mutation 原子地抢占初始化权，只有一个客户端能从 `pending` 变成 `initializing`。
4. 只有抢占成功的客户端向 Room 写入 `initialContent`，写入成功并确认同步后，再将状态更新为 `ready`。
5. 其他客户端等待 `ready`，然后直接使用 Room 中的正文，不再使用本地拿到的初始内容覆盖编辑器。

如果初始化过程中网络中断，我不会把状态直接标记为 `ready`。Liveblocks Provider 会保持同步状态，项目中也开启了 `offlineSupport_experimental`，可以通过 IndexedDB 暂存本地 Yjs 数据，网络恢复后再同步。如果初始化客户端失败，则通过带租约或超时的 `initializing` 状态允许其他客户端重新抢占，并且整个过程需要保持幂等，避免重复写入。

所以总结来说，当前版本依赖 Liveblocks 的 `hasContentSet` 处理正常并发；如果要满足强一致的一次性初始化，我会再结合 Convex 的原子状态、初始化期间的只读控制和失败重试机制。