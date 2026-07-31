这次回答比较好，能主动识别“共享标记不等于严格的原子锁”这一边界。

下一题考察 React 状态管理和性能：

你把 Tiptap 的 `editor` 实例放进 Zustand，并用它协调工具栏和编辑器。请具体说明：

- 为什么不直接使用 React Context，而选择 Zustand？
- 用户每次输入都会触发编辑器状态变化，你如何避免整个页面或工具栏频繁重渲染？
- `editor` 实例在 Next.js App Router 中属于服务端组件还是客户端组件？如何处理初始化、销毁和 hydration 问题？

这个问题我会结合项目当前实现和可以继续优化的地方来回答。

首先，选择 Zustand 主要是因为 `editor` 本质上是一个带有大量命令和内部状态的命令式实例，不适合把整个对象状态通过 React Context 在组件树中层层传递。工具栏、菜单栏、图片按钮等组件都需要访问同一个 Editor 实例，Zustand 可以让这些客户端组件直接访问共享实例，也不需要额外增加 Provider 层。

当然，Context 也可以实现，尤其是把 Editor 放在 `useRef` 中时也能避免因为实例变化导致更新。但 Zustand 提供了更方便的选择器订阅能力，后续还可以把编辑器实例、工具栏状态和其他 UI 状态拆开管理。

这里需要说明，项目当前的实现还有优化空间。现在 `Editor` 组件在 `onCreate`、`onUpdate`、`onSelectionUpdate`、`onTransaction` 等回调中都会调用 `setEditor(editor)`，而工具栏部分使用的是：

```ts
const { editor } = useEditorStore();
```

这相当于订阅整个 Store。虽然 Editor 实例本身引用没有变化，不会导致整个页面重新渲染，但这些 Store 更新会通知所有订阅了它的工具栏和菜单组件。因此我不会说当前代码已经完全避免了工具栏重渲染。

更合理的做法是：

第一，Zustand 中只在 `onCreate` 时保存 Editor 实例，在 `onDestroy` 时清空，不要在每次输入和事务中重复保存同一个引用。

第二，使用精确选择器：

```ts
const editor = useEditorStore((state) => state.editor);
```

这样只有 Editor 引用真正发生变化时，组件才会重渲染。对于只执行命令、不需要展示激活状态的按钮，还可以通过 `useEditorStore.getState().editor` 获取实例，完全不建立响应式订阅。

第三，对于粗体、斜体、标题等激活状态，我会使用 Tiptap 的 `useEditorState`，只订阅需要的布尔值，例如 `isBold`、`isItalic`，而不是让整个工具栏跟随所有编辑事务更新。同时可以拆分按钮组件并配合 `React.memo`，把更新范围限制在当前状态确实变化的按钮上。

最后，Tiptap 的 Editor 实例一定属于客户端组件。项目中的 `page.tsx` 是服务端组件，负责 Clerk 鉴权和 Convex 数据预加载；`Document`、`Room` 和 `Editor` 使用 `"use client"`，负责创建和操作 Tiptap、Liveblocks 以及浏览器 DOM。Editor 实例包含 DOM 引用、事件监听器和方法，既不能在服务端创建，也不能作为 Server Component 的序列化数据传递。

为了解决 hydration 问题，我在 `useEditor` 中设置了：

```ts
immediatelyRender: false
```

让 Tiptap 不在服务端渲染阶段立即创建 ProseMirror DOM，而是等客户端挂载后再初始化。Editor 创建成功后通过 `onCreate` 放入 Zustand，组件卸载时通过 `onDestroy` 清空，避免路由切换后工具栏继续引用旧的 Editor 实例。Liveblocks 部分则通过 `ClientSideSuspense` 等待 Room 初始化完成后再显示编辑器内容。