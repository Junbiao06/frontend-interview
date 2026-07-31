时区、业务日期和任务幂等的处理都比较规范，尤其是使用 `businessDate` 和唯一索引把“日期归属”从时间点中解耦出来。

下一题回到 `co-docs-editor` 的 Next.js 渲染边界：

服务端页面预加载了 Convex 中的 `initialContent`，但 Liveblocks Room 中可能已经存在更新后的正文。这样服务端生成的 HTML 和客户端最终加载的内容可能不一致。

请说明你如何避免：

- hydration mismatch；
- 页面先闪现旧正文，再切换到实时正文；
- 服务端组件误传不可序列化的 Editor、Room 或函数；
- Liveblocks 尚未连接时用户误操作编辑器。

这里我会把“Convex 初始数据”和“Liveblocks 实时数据”明确区分开。

整体数据流是：

```
Next.js Server Component
  → 鉴权并预加载文档元数据和 initialContent
  → 客户端创建 RoomProvider
  → Liveblocks 同步 Y.Doc
  → Tiptap 根据 Room 中的最新正文渲染
```

为了避免 hydration mismatch，服务端不会直接把 `initialContent` 转成 Tiptap 的 HTML。服务端只负责返回页面外壳、标题、加载骨架和 Convex 预加载数据。真正的 Tiptap Editor 在客户端创建，并设置：

```
useEditor({
  immediatelyRender: false,
});
```

这样 Tiptap 不会在服务端阶段创建依赖 DOM 的 ProseMirror 结构，避免服务端 HTML 和客户端 Editor DOM 不一致。

`initialContent` 只是 Liveblocks Room 为空时的初始化种子，不是服务端最终要展示的正文。客户端进入 Room 后，先从 Liveblocks 同步 Y.Doc。如果 Room 已经存在内容，就使用 Room 中的最新内容；只有 Room 为空且共享初始化标记不存在时，才使用 `initialContent`。

为了避免页面先显示旧正文再切换，我不会让服务端先渲染 `initialContent`，而是使用 `ClientSideSuspense` 或自定义同步状态：

```
<ClientSideSuspense fallback={<DocumentLoadingSkeleton />}>
  <Editor />
</ClientSideSuspense>
```

在 Liveblocks 尚未同步完成前，页面显示骨架屏或同步状态。等 Room 进入可用状态后，再挂载 Editor。这样用户看到的第一份正文就是经过实时层确认后的内容，而不是先看到 Convex 的旧快照。

如果产品希望更早展示界面，也可以先挂载 Editor，但必须设置为只读：

```
editor.setEditable(false);
```

等 Liveblocks 状态变为 `synchronized` 后，再开放编辑，并启用工具栏按钮。同步失败时保持只读并显示重试提示，不能让用户在还没有确认 Room 状态时继续编辑。

关于 Server Component 和 Client Component 的边界：

- 服务端页面可以处理 Clerk 鉴权、Convex 预加载和路由参数；
- 服务端只能向客户端传递可序列化的数据，或者 Convex 支持的预加载查询句柄；
- `Editor` 实例、Liveblocks `Room`、事件处理函数和 DOM 引用都必须在客户端创建；
- `RoomProvider`、`LiveblocksProvider` 和 Tiptap `useEditor` 都放在带有 `"use client"` 的组件中。

例如当前页面可以由服务端预加载：

```
const preloadedDocument = await preloadQuery(
  api.documents.getById,
  { id: documentId },
  { token },
);
```

然后交给客户端组件使用；但不能把已经创建好的 Editor 实例或 Room 从服务端传给客户端。

最后，工具栏也需要跟随同步状态控制。未连接时，撤销、导出、插入图片等依赖 Editor 的操作应该禁用，或者在命令执行前判断：

```
if (!editor || !isSynced) return;
```

这样可以同时解决四个问题：

```
服务端不渲染 Tiptap DOM → 避免 hydration mismatch
等待 Liveblocks 同步后再展示正文 → 避免旧内容闪现
只传递可序列化数据 → 避免跨 Server/Client 边界错误
未同步时只读或显示骨架屏 → 避免用户误操作和内容覆盖
```