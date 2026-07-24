# 从零实现一个迷你 React：虚拟 DOM、Fiber、Diff 与 Commit

> 这篇文章配套同目录下的 `react.js` 和 `react.html` 使用。它的目标不是复刻完整的 React 源码，而是用尽可能少的代码，把 React 最重要的几个思想串成一条真正能运行的链路。

## 一、最后要做出什么

我们希望实现这样一条完整的流程：

```text
JSX / createElement
        ↓
Virtual DOM 对象
        ↓
render 创建 work-in-progress 根 Fiber
        ↓
时间切片中逐个处理 Fiber
        ↓
构建新 Fiber 树，同时对比旧 Fiber 树
        ↓
为 Fiber 标记 PLACEMENT / UPDATE / DELETION
        ↓
整棵新 Fiber 树构建完成
        ↓
commit 阶段一次性修改真实 DOM
        ↓
保存 currentRoot，为下一次 Diff 做准备
```

这个实现支持：

- 普通 DOM 标签；
- 文本节点；
- 函数组件；
- 嵌套 children 数组；
- 忽略 `null`、`undefined` 和布尔子节点；
- 空闲时间调度和中断后继续；
- 基于位置和类型的简化 Diff；
- DOM 新增、更新与删除；
- 普通属性、自定义 attribute、style 对象和事件处理函数。

它还没有实现真正 React 中的 key Diff、Hooks、优先级调度、Suspense、Context、合成事件、hydration 等功能。这很正常，因为学习版最重要的是先看清骨架。

---

## 二、先理解三个不同层次的对象

很多人第一次看这类代码时，会把虚拟 DOM、Fiber 和真实 DOM 混在一起。先把它们分开，后面会轻松很多。

### 1. 虚拟 DOM

虚拟 DOM 是对“我想要什么界面”的轻量描述。

```js
{
  type: "div",
  props: {
    id: "foo",
    children: []
  }
}
```

它是普通 JavaScript 对象，自身不能显示在页面上。它更像一张图纸。

### 2. Fiber

Fiber 是对“这份渲染工作怎么做”的描述。它除了保存 `type` 和 `props`，还保存了工作遍历所需的关系以及更新信息：

```js
{
  type,
  props,
  dom,
  parent,
  child,
  sibling,
  alternate,
  effectTag
}
```

Fiber 最关键的价值是：它把原本一次性递归完成的工作，拆成了一个个可记录、可暂停、可恢复的工作单元。

### 3. 真实 DOM

真实 DOM 是浏览器最终会展示的节点，例如：

```js
document.createElement("div");
document.createTextNode("hello");
```

在我们的实现中，Fiber 的 `dom` 字段会指向对应的真实 DOM。函数组件是一个例外：它只负责返回元素，没有自己的 DOM，所以它的 `fiber.dom` 是 `null`。

可以用一句话记住：

> 虚拟 DOM 描述结果，Fiber 描述工作，真实 DOM 负责展示。

---

## 三、第一步：实现 `createElement`

### 1. JSX 并不是浏览器原生语法

当我们写：

```jsx
<div id="foo">
  <span>bar</span>
</div>
```

Babel 可以把它编译为类似：

```js
React.createElement(
  "div",
  { id: "foo" },
  React.createElement("span", null, "bar"),
);
```

所以我们先不需要真正引入 Babel。只要手写 `React.createElement` 的调用，一样能理解 JSX 的产物。

### 2. `createElement` 生成什么

```js
createElement(type, props, ...children) {
  return {
    type,
    props: {
      ...(props || {}),
      children: normalizeChildren(children),
    },
  };
}
```

`type` 可以是：

- `"div"`、`"span"` 这样的字符串，代表浏览器 DOM 标签；
- `App` 这样的函数，代表函数组件；
- `"TEXT_ELEMENT"`，这是我们自己约定的文本节点类型。

### 3. 为什么文本也要包装成对象

假设 `children` 中的普通元素是对象，文本却是字符串，后续 Diff 时就必须到处写分支。

所以我们把文本也归一化为虚拟 DOM：

```js
createTextElement(text) {
  return {
    type: "TEXT_ELEMENT",
    props: {
      nodeValue: String(text),
      children: [],
    },
  };
}
```

例如字符串 `"bar"` 会变成：

```js
{
  type: "TEXT_ELEMENT",
  props: {
    nodeValue: "bar",
    children: []
  }
}
```

这样以后无论是 DOM 元素还是文本，都有统一的 `type + props + children` 结构。

### 4. 为什么需要 `normalizeChildren`

原始实现只判断了 `typeof child === "object"`，但这会有几个问题：

- `typeof null === "object"`，会把 `null` 错误当成元素；
- `array.map(...)` 产生的子节点数组会被当成单个元素；
- 条件渲染经常产生 `false`，它不应该显示成文本 `"false"`；
- 数字 `0` 是合法的文本，不能用简单的 `filter(Boolean)` 删掉。

因此要做三件事：

```js
function normalizeChildren(children) {
  return children
    .flat(Infinity)
    .filter(
      (child) =>
        child !== null &&
        child !== undefined &&
        typeof child !== "boolean",
    )
    .map((child) =>
      typeof child === "object" ? child : React.createTextElement(child),
    );
}
```

第一步拉平数组，第二步过滤不需要渲染的值，第三步把原始值包装为文本元素。

---

## 四、第二步：从虚拟 DOM 创建真实 DOM

创建 DOM 的函数很直接：

```js
function createDom(fiber) {
  const dom =
    fiber.type === "TEXT_ELEMENT"
      ? document.createTextNode("")
      : document.createElement(fiber.type);

  updateDom(dom, {}, fiber.props);
  return dom;
}
```

注意我们没有在 `createTextNode` 时直接传文本，而是先创建空文本节点，然后让所有属性都通过 `updateDom` 设置。

文本节点的 `nodeValue` 本来就是 DOM 属性，所以这样做可以让首次创建和后续更新共用同一套逻辑。

但这时只是“创建了 DOM 对象”，还没有将它插入页面。真正的插入会放到 commit 阶段进行。

---

## 五、第三步：创建根 Fiber

当用户调用：

```js
React.render(element, document.getElementById("root"));
```

我们不应该马上递归创建整棵 DOM 树，而是先创建一个工作根节点：

```js
wipRoot = {
  type: null,
  dom: container,
  props: {
    children: normalizeChildren([element]),
  },
  parent: null,
  child: null,
  sibling: null,
  alternate: currentRoot?.dom === container ? currentRoot : null,
  effectTag: null,
};
```

`wipRoot` 是 work in progress root，意思是“正在工作中的根”。

这个根 Fiber 不对应新 DOM。它的 `dom` 直接复用用户传入的 `container`，也就是 `<div id="root"></div>`。

同时还要设置：

```js
deletions = [];
nextUnitOfWork = wipRoot;
```

`deletions` 记录旧树中要删掉的 Fiber，`nextUnitOfWork` 则告诉调度器第一个工作单元是根 Fiber。

### `alternate` 有什么用

第一次 render 时，`currentRoot` 还不存在，所以 `alternate` 是 `null`。

第二次 render 时：

- `wipRoot` 是新树；
- `currentRoot` 是旧树；
- `wipRoot.alternate` 指向 `currentRoot`。

后续每个新 Fiber 的 `alternate` 也会指向同一位置上的旧 Fiber。我们就是通过这条线读到旧 props 和旧 DOM，完成 Diff 和复用。

---

## 六、第四步：为什么不直接递归整棵树

假设页面有几万个节点，我们写一个大递归：

```js
function buildEverything(element) {
  // 不停地创建节点并递归子节点……
}
```

一旦这个函数开始执行，JavaScript 主线程可能很久都无法处理用户输入、动画和浏览器绘制。

Fiber 的基本思路是：

1. 每次只处理一个 Fiber；
2. 处理完后明确返回下一个 Fiber；
3. 如果浏览器快没有空闲时间了，就停下；
4. 下一个空闲时段再从 `nextUnitOfWork` 继续。

这就是“可中断渲染”在这个学习实现中的核心。

### `requestIdleCallback`

我们用它请求浏览器在空闲时执行 `workLoop`：

```js
scheduleIdleCallback(workLoop);
```

`deadline.timeRemaining()` 大致可以告诉我们当前空闲时段还剩多少时间。

```js
function workLoop(deadline) {
  let shouldYield = false;

  while (nextUnitOfWork && !shouldYield) {
    nextUnitOfWork = performUnitOfWork(nextUnitOfWork);
    shouldYield = deadline.timeRemaining() < 1;
  }
}
```

每次 `performUnitOfWork` 完成一个 Fiber，再判断要不要让出主线程。

### 为什么还要做降级处理

`requestIdleCallback` 并不是所有浏览器都支持。为了让示例可以运行，我们用 `setTimeout` 提供一个学习用 fallback。

需要明确：真正 React 的调度器要复杂得多，并不是简单地将 `requestIdleCallback` 包装一层。我们这里只是用它演示“工作可分割”的概念。

### 为什么要防止重复调度

如果 `render` 调一次 `requestIdleCallback(workLoop)`，`workLoop` 末尾又无条件调一次，之后多次 `render` 就可能产生多条调度链。即使已经没有任务，它们也会一直被唤醒。

所以我们增加：

```js
let isWorkLoopScheduled = false;
```

每次调度前先检查，只在确实还有工作时再约下一次回调。

---

## 七、第五步：把树改造成可恢复遍历的结构

普通的树通常使用 `children` 数组。Fiber 为了方便记录下一个工作单元，使用了三个指针：

- `child`：第一个子节点；
- `sibling`：下一个兄弟节点；
- `parent`：父节点。

假设有这棵树：

```text
A
├─ B
│  ├─ D
│  └─ E
└─ C
   └─ F
```

它的工作顺序是：

```text
A → B → D → E → C → F
```

这就是深度优先遍历。但我们不使用隐式的函数调用栈，而是用 `parent / child / sibling` 显式寻找下一个节点。

```js
if (fiber.child) return fiber.child;

let nextFiber = fiber;
while (nextFiber) {
  if (nextFiber.sibling) return nextFiber.sibling;
  nextFiber = nextFiber.parent;
}

return null;
```

这段代码可以分成三句话：

1. 有孩子，就先去孩子；
2. 没有孩子，就去兄弟；
3. 连兄弟也没有，就不断向上找，直到某个祖先还有兄弟。

当最后返回 `null` 时，说明整棵树的 render 工作已经完成。

---

## 八、第六步：处理原生元素和函数组件

`performUnitOfWork` 先判断 Fiber 是哪种类型：

```js
function performUnitOfWork(fiber) {
  if (typeof fiber.type === "function") {
    updateFunctionComponent(fiber);
  } else {
    updateHostComponent(fiber);
  }

  // 再寻找下一个 Fiber
}
```

### 1. Host Component

`div`、`button`、`TEXT_ELEMENT` 都是 host component，因为它们有对应的真实 DOM。

```js
function updateHostComponent(fiber) {
  if (!fiber.dom) {
    fiber.dom = createDom(fiber);
  }
  reconcileChildren(fiber, fiber.props.children || []);
}
```

首次遇到时创建 DOM，然后协调子节点。如果更新时已经复用了旧 DOM，`fiber.dom` 已存在，不会重复创建。

### 2. Function Component

函数组件本质上就是调用函数，得到它返回的元素：

```js
function updateFunctionComponent(fiber) {
  const returnedElement = fiber.type(fiber.props);
  reconcileChildren(fiber, normalizeChildren([returnedElement]));
}
```

例如：

```js
function Welcome({ name }) {
  return React.createElement("h1", null, "Hello ", name);
}
```

当 `fiber.type === Welcome` 时：

```js
fiber.type(fiber.props);
```

等价于：

```js
Welcome({ name: "Tom" });
```

它返回的 `h1` 元素会成为函数组件 Fiber 的子节点。

函数组件本身没有 DOM，所以后面向上寻找 DOM 父节点时，必须跳过这类 Fiber。

---

## 九、第七步：协调子节点

`reconcileChildren` 同时做两件事：

1. 把新元素数组转成新 Fiber 链表；
2. 对比新元素和旧 Fiber，决定是复用、新增还是删除。

### 1. 从哪里找到旧子节点

```js
let oldFiber = wipFiber.alternate?.child || null;
```

`wipFiber.alternate` 是旧树中对应的父 Fiber，它的 `child` 就是旧子节点链表的起点。

### 2. 为什么循环条件必须同时看新、旧两边

错误的写法是：

```js
while (index < elements.length) {
  // ...
}
```

假设旧子节点是：

```text
A B C
```

新子节点是：

```text
A
```

`elements.length` 为 1，处理完 A 循环就结束了，旧树里的 B 和 C 永远没有机会被标记删除。

正确条件应该是：

```js
while (index < elements.length || oldFiber) {
  // ...
}
```

只要新数组还没读完，或者旧 Fiber 链表还没走完，就必须继续。

### 3. 这个简化 Diff 只比较类型

```js
const sameType = Boolean(
  oldFiber && element && oldFiber.type === element.type,
);
```

它隐含了“同一层级、同一位置”的前提。

我们把结果分成三种：

| 旧 Fiber | 新 element | 类型是否相同 | 结果 |
| --- | --- | --- | --- |
| 有 | 有 | 是 | `UPDATE`，复用 DOM |
| 无或类型不同 | 有 | 否 | `PLACEMENT`，创建新 Fiber |
| 有 | 无或类型不同 | 否 | 旧 Fiber 记为 `DELETION` |

注意：类型不同会同时发生“新增新节点”和“删除旧节点”。

### 4. `UPDATE`：复用 DOM

```js
if (sameType) {
  newFiber = {
    type: oldFiber.type,
    props: element.props,
    parent: wipFiber,
    dom: oldFiber.dom,
    child: null,
    sibling: null,
    alternate: oldFiber,
    effectTag: "UPDATE",
  };
}
```

这里最重要的是：

```js
dom: oldFiber.dom
```

我们并没有创建一个新 DOM，而是把旧 DOM 指针放到新 Fiber 上。提交时只要比较旧 props 和新 props 即可。

### 5. `PLACEMENT`：新增 Fiber

```js
if (element && !sameType) {
  newFiber = createFiber(element, wipFiber);
  newFiber.effectTag = "PLACEMENT";
}
```

在 render 阶段，这个 Fiber 对应的 DOM 可以被创建出来，但暂时不插入页面。

### 6. `DELETION`：保存旧 Fiber

```js
if (oldFiber && !sameType) {
  oldFiber.effectTag = "DELETION";
  deletions.push(oldFiber);
}
```

删除是一个特殊情况：被删除的 Fiber 本来就不会出现在新 Fiber 树中，所以无法在之后遍历新树时找到它。因此必须将它放进独立的 `deletions` 数组。

### 7. 怎么把新 Fiber 连成树

```js
if (newFiber) {
  if (!prevSibling) {
    wipFiber.child = newFiber;
  } else {
    prevSibling.sibling = newFiber;
  }
  prevSibling = newFiber;
}
```

父 Fiber 只保存第一个孩子，后面的孩子依次通过 `sibling` 串起来。

必须在 `newFiber` 存在时才更新 `prevSibling`。如果当前只是删除一个旧节点，`newFiber` 是 `null`，就不能把它连进新树。

---

## 十、第八步：为什么分成 render 和 commit 两个阶段

我们在时间切片中所做的工作，可以统称为 render 阶段：

- 创建 Fiber；
- 创建还没有插入页面的 DOM；
- 比较新旧 Fiber；
- 记录 effectTag；
- 构建 work-in-progress 树。

这些工作可以停下来，因为它们尚未改变用户看到的页面。

如果我们每处理一个 Fiber 就立即 `appendChild`，时间切片暂停时，用户就可能看到只更新了一半的页面。

所以要等：

```js
if (!nextUnitOfWork && wipRoot) {
  commitRoot();
}
```

只有当整棵新 Fiber 树构建完成后，才进入 commit 阶段。

commit 会真正修改 DOM，因此它不能做到一半暂停。在这个简化实现里，它会一次性完成。

---

## 十一、第九步：提交新增和更新

### 1. 先找到真正的 DOM 父节点

当前 Fiber 的直接父 Fiber 不一定有 DOM，因为中间可能有函数组件：

```text
div DOM
  ↓
App Fiber（无 DOM）
  ↓
Section Fiber（无 DOM）
  ↓
p DOM
```

因此需要不断向上跳过没有 DOM 的 Fiber：

```js
function getDomParent(fiber) {
  let parentFiber = fiber.parent;
  while (parentFiber && !parentFiber.dom) {
    parentFiber = parentFiber.parent;
  }
  return parentFiber?.dom || null;
}
```

### 2. 提交 `PLACEMENT`

最简单的新增是：

```js
domParent.appendChild(fiber.dom);
```

但这个写法有一个隐藏 bug：如果新节点是替换中间的节点，`appendChild` 会把它放到最后。

例如旧 DOM 是：

```html
<strong>A</strong>
<p>B</p>
```

新元素是：

```html
<em>A</em>
<p>B</p>
```

删掉 `strong` 后，如果对 `em` 使用 `appendChild`，结果会变成：

```html
<p>B</p>
<em>A</em>
```

顺序错了。

所以实现中会寻找后面第一个不是新增状态的 DOM 兄弟：

```js
const domSibling = getHostSibling(fiber);
domParent.insertBefore(fiber.dom, domSibling);
```

如果找到 `p`，就把 `em` 插到 `p` 前面。如果没找到，`insertBefore(node, null)` 的效果和 `appendChild` 一样。

`getHostSibling` 也要跳过没有 DOM 的函数组件 Fiber，以及同样处于 `PLACEMENT` 状态的新兄弟。因为新兄弟此时还不是一个稳定的 DOM 锚点。

### 3. 提交 `UPDATE`

如果类型相同，Fiber 已经复用旧 DOM，只要对比属性：

```js
updateDom(
  fiber.dom,
  fiber.alternate.props,
  fiber.props,
);
```

`fiber.alternate.props` 是旧 props，`fiber.props` 是新 props。

---

## 十二、第十步：正确更新 DOM 属性

一个太简单的 `updateDom` 可能会先把所有旧属性清空，再把所有新属性赋值。它在 `id` 和 `nodeValue` 这种场景上看起来能工作，但会有不少问题：

- 没变化的属性也被重复修改；
- 事件处理函数没有正确解绑；
- `data-*` 和 `aria-*` 更适合通过 attribute 设置；
- `style` 对象不能直接粗暴赋给 `dom.style`；
- 删除布尔属性和删除普通 attribute 的方式不一样。

所以我们把更新分成五组。

### 1. 移除旧事件

如果旧事件在新 props 中消失了，或者处理函数换了，就先解绑：

```js
dom.removeEventListener(eventType, prevProps[name]);
```

这一步非常重要。如果每次 render 都只添加新 listener，一个点击会触发越来越多次回调，而且旧闭包也会一直被引用。

### 2. 删除已消失的普通属性

判断新 props 中是否已经没有该 key：

```js
const isGone = (nextProps) => (name) => !(name in nextProps);
```

如果属性是 DOM 对象自身的 property，例如 `value`、`checked`、`className`，就清空 property。否则使用 `removeAttribute`。

### 3. 单独 Diff style

例如旧 style 是：

```js
{ color: "red", marginTop: "8px" }
```

新 style 是：

```js
{ color: "blue" }
```

我们需要同时做：

```js
dom.style.marginTop = "";
dom.style.color = "blue";
```

不能只设置新属性，否则旧的 `marginTop` 会残留。

### 4. 设置新增或变化的普通属性

只处理：

```js
prevProps[name] !== nextProps[name]
```

对于 DOM 自身有的 property，直接赋值。对于自定义 attribute，使用 `setAttribute`。

### 5. 添加新事件

```js
const eventType = name.slice(2).toLowerCase();
dom.addEventListener(eventType, nextProps[name]);
```

`onClick` 会被转成 `click`，`onInput` 会被转成 `input`。

这只是学习版的直接 DOM 事件绑定。真正 React 的事件系统还有事件委托、优先级等更多机制。

---

## 十三、第十一步：正确提交删除

### 1. 为什么不应该对删除 Fiber 直接调用通用 `commitWork`

被删除的 Fiber 来自旧树。它的 `sibling` 也指向旧树兄弟。

如果执行：

```js
deletions.forEach(commitWork);
```

而 `commitWork` 末尾又递归：

```js
commitWork(fiber.child);
commitWork(fiber.sibling);
```

那么删除一个旧 Fiber 时，可能会跟着进入它的旧兄弟树，对不该提交的旧 Fiber 再次执行操作。

因此删除应该走独立入口：

```js
deletions.forEach(commitDeletionEffect);
```

这个入口只寻找 DOM 父节点并删除当前待删子树，不会沿旧 Fiber 的外部 `sibling` 继续提交。

### 2. 删除普通 DOM Fiber

```js
if (fiber.dom) {
  domParent.removeChild(fiber.dom);
  return;
}
```

删除一个 DOM 节点时，浏览器自然会连同它的 DOM 子树一起移除，所以不需要再递归它的 Fiber 子节点。

### 3. 删除函数组件 Fiber

函数组件没有自己的 DOM，因此必须进入它的子树。

而且函数组件可能有多个 DOM 子分支，不能只删第一个 child，还要沿 sibling 遍历：

```js
let child = fiber.child;
while (child) {
  commitDeletion(child, domParent);
  child = child.sibling;
}
```

这里遍历的 sibling 是“待删函数组件内部的子节点”，不是函数组件自己在外部的兄弟。

---

## 十四、第十二步：保存已提交的 Fiber 树

提交完成后：

```js
currentRoot = wipRoot;
wipRoot = null;
deletions = [];
```

这三行代码表示：

1. 刚刚构建的新树已经变成当前页面对应的旧树；
2. 当前已经没有进行中的 work-in-progress 树；
3. 待删列表已经消费完成。

下一次再调用 `render` 时，新的 `wipRoot.alternate` 就会指向这个 `currentRoot`。

如果没有 `currentRoot`，系统每次只能当成首次渲染，无法知道哪些 DOM 能复用。

---

## 十五、完整走一遍首次渲染

以示例中的调用为例：

```js
React.render(
  React.createElement(App, { count: 0 }),
  document.getElementById("root"),
);
```

### 阶段 1：创建虚拟 DOM

`React.createElement(App, { count: 0 })` 先生成：

```js
{
  type: App,
  props: {
    count: 0,
    children: []
  }
}
```

### 阶段 2：创建根 Fiber

`render` 创建 `wipRoot`，把 App 元素放进它的 `props.children`。因为是首次渲染，`alternate` 为 `null`。

### 阶段 3：处理根 Fiber

根 Fiber 已经持有 container DOM，不需要创建 DOM。

`reconcileChildren` 看到 App 元素，但没有 oldFiber，因此创建 App Fiber，标记为 `PLACEMENT`。

### 阶段 4：处理 App Fiber

App 是函数，执行：

```js
App({ count: 0, children: [] });
```

得到 `main` 元素，再为它创建 `PLACEMENT` Fiber。

App Fiber 没有 DOM。

### 阶段 5：处理 main 及后代

main Fiber 创建真实 `<main>`，但此时它仍然没有进入 container。

然后依次为 `h1`、`strong`、`p`、`button`、`ul` 和文本节点建立 Fiber，并创建相应 DOM。

所有 Fiber 因为没有旧树，都是 `PLACEMENT`。

### 阶段 6：整棵新树完成

`performUnitOfWork` 最终返回 `null`，所以 `nextUnitOfWork` 为空。

### 阶段 7：commit

App Fiber 没有 DOM，跳过它自己的插入。

main Fiber 的 DOM 父节点是根 container，所以将 `<main>` 插入 `<div id="root">`。

接着遍历 main 的子 Fiber，把它们各自插入对应父 DOM。

最后 `currentRoot = wipRoot`，首次渲染结束。

---

## 十六、再完整走一遍点击后的更新

点击按钮后：

```js
demoCount += 1;
mountDemo();
```

`count` 从 0 变成 1。

### 1. 新建 wipRoot

这一次 `wipRoot.alternate` 会指向上一次的 `currentRoot`。

### 2. App Fiber 类型相同

新、旧 Fiber 的 `type` 都是 App，因此新 App Fiber 是 `UPDATE`，并通过 `alternate` 指向旧 App Fiber。

### 3. main Fiber 类型相同

main DOM 会被复用。`data-count` 由 0 变成 1，commit 时会修改这个 attribute。

### 4. `strong` 变成 `em`

这两个 Fiber 处在同一位置，但类型不同，所以：

- 新 `em` Fiber 标记为 `PLACEMENT`；
- 旧 `strong` Fiber 放入 `deletions`。

commit 时先删除 `strong`，再通过 `insertBefore` 把 `em` 插到后面 `p` 之前，所以 DOM 顺序不会错乱。

### 5. 状态文本从 0 变成 1

对应文本 Fiber 的类型仍然是 `TEXT_ELEMENT`，DOM 复用，但 `nodeValue` 从 `"0"` 变成 `"1"`。

commit 时 `updateDom` 会设置文本 DOM 的 `nodeValue`。

### 6. button 的 onClick 函数变了

每次 App 执行都会创建新的箭头函数。`updateDom` 会：

1. 移除旧 listener；
2. 添加新 listener。

这能验证我们的事件 Diff 没有重复累积回调。

### 7. 列表从三项变成两项

旧列表是：

```text
虚拟 DOM / Fiber / Commit
```

新列表是：

```text
Fiber / Commit
```

这个实现没有 key，所以它会按位置处理：

- 第一个 `li` 复用，文本从“虚拟 DOM”改为“Fiber”；
- 第二个 `li` 复用，文本从“Fiber”改为“Commit”；
- 第三个旧 `li` 被删除。

这正好可以验证循环条件是否写成了：

```js
while (index < elements.length || oldFiber)
```

如果仍然只检查新数组长度，第三个 `li` 就会永远残留在页面。

---

## 十七、原实现中需要修正的问题汇总

### 1. HTML 中没有 `#root`

JavaScript 调用了：

```js
document.getElementById("root")
```

但 HTML 中没有这个元素，所以 container 是 `null`。现在 HTML 中已增加：

```html
<div id="root"></div>
```

`render` 也增加了容器检查，这样以后即使再写错 id，也会得到明确错误。

### 2. 尾部旧节点无法删除

已由：

```js
while (index < elements.length)
```

改为：

```js
while (index < elements.length || oldFiber)
```

### 3. `element` 可能为空却直接读取 `element.type`

现在先确保 `element` 存在：

```js
oldFiber && element && oldFiber.type === element.type
```

而且在 `createElement` 阶段已经规范化 children，过滤掉空值。

### 4. 只以 `element` 为条件连接兄弟节点

新树真正应该连接的是 `newFiber`，而不是原始 element。现在只在 `newFiber` 存在时才连接，也不会把 `prevSibling` 错误改成 `null`。

### 5. updateDom 每次粗暴清空所有旧属性

现在改成真正比较新旧值，并分开处理事件、style、DOM property 和 attribute。

### 6. 事件更新不完整

直接写 `dom[name] = nextProps[name]` 对一些简单事件属性可能看起来有效，但不利于明确地比较、解绑和管理 listener。现在统一使用 `addEventListener` 和 `removeEventListener`。

### 7. 新节点总是 `appendChild`，中间替换时顺序可能错误

现在通过 `getHostSibling` 找到稳定锚点，再使用 `insertBefore`。

### 8. 删除 Fiber 时误遍历旧兄弟

现在删除 effect 不再直接使用会递归 sibling 的通用 `commitWork`，而是使用独立的 `commitDeletionEffect`。

### 9. 函数组件删除时只处理了第一个 child

现在会遍历函数组件下面所有兄弟子树，删除所有真实 DOM 分支。

### 10. 多次 render 可能重复注册工作循环

现在通过 `isWorkLoopScheduled` 保证同一时刻最多只有一个已经预约的 work loop，并且没有工作时不会永久空转。

### 11. 没有 `requestIdleCallback` 时会直接报错

现在增加了 `setTimeout` fallback，使学习示例能在更多浏览器里运行。

### 12. 没有函数组件处理分支

原来无论 `fiber.type` 是什么都会调用 `document.createElement(fiber.type)`。如果 type 是函数，这个操作就不正确。现在会在 `performUnitOfWork` 中分流。

---

## 十八、这个 Diff 为什么还不能处理 key

我们现在同时向后移动：

- `index`：新元素数组的下标；
- `oldFiber`：旧兄弟链表指针。

所以它只能对比同一位置。

例如：

```text
旧：A B C
新：B C
```

即使 A、B、C 都是有独立身份的数据，当前算法也会认为：

- 第一个节点从 A 更新为 B；
- 第二个节点从 B 更新为 C；
- 删除第三个节点。

如果节点里有输入框状态或组件内部状态，这种“按位置复用”就可能让状态跟错数据。

key Diff 的基本方向是：

1. 为旧子 Fiber 建立 `key -> fiber` 映射；
2. 遍历新子节点，先通过 key 找到旧 Fiber；
3. key 和 type 都一致时复用；
4. 旧 Fiber 存在但位置变了时记录移动 effect；
5. 映射中最后没被复用的旧 Fiber 全部删除。

这可以作为完成当前版本后的第一个进阶练习。

---

## 十九、时间复杂度与空间复杂度

假设本次渲染共有 `n` 个 Fiber。

### render 阶段

每个 Fiber 基本上被处理一次，所以总的时间复杂度可以看作 `O(n)`。

简化的同层 Diff 是新、旧两个指针一起向后走，同样是线性。

### commit 阶段

我们现在遍历整棵新 Fiber 树，即使某些 Fiber 没有实际 DOM 改动，也会经过它们，所以上界也是 `O(n)`。

`getHostSibling` 在最坏情况下可能额外扫描后续 Fiber。这是学习版为了保证插入顺序正确而采用的简化实现。

### 空间复杂度

更新期间同时保留：

- `currentRoot` 旧 Fiber 树；
- `wipRoot` 新 Fiber 树；
- `deletions` 数组。

因此额外空间是 `O(n)` 级别。这就是通常所说的“双缓冲 Fiber 树”的直观形态：一棵对应当前界面，一棵正在构建下一个界面。

---

## 二十、如何调试这个实现

### 1. 先验证首次渲染

打开 `react.html`，确认能看到：

- `Mini React / Fiber` 标题；
- “当前是偶数”徽标；
- “已更新 0 次”；
- 三项列表；
- 更新按钮。

如果这一步失败，优先检查：

- HTML 里是否有 `#root`；
- JavaScript 文件路径是否正确；
- 控制台是否有语法错误；
- `render` 收到的 container 是否为 `null`。

### 2. 验证 UPDATE

点击一次按钮，确认文本从 0 变成 1。

在 `updateDom` 内部临时加入日志：

```js
console.log("update", dom, prevProps, nextProps);
```

可以看到同类型 Fiber 是如何复用 DOM 的。

### 3. 验证中间节点替换

点击后 `strong` 会变成 `em`，但它仍应该在状态段落 `p` 前面。

如果它跑到卡片最后，说明使用了 `appendChild` 而没有找正确的 DOM 兄弟锚点。

### 4. 验证尾部删除

点击后列表从三项变成两项。如果仍保留三项，检查 `reconcileChildren` 的 while 条件。

### 5. 验证事件没有重复绑定

连续点击按钮，数字应该每次只增加 1。

如果出现 1、3、7 之类越跳越快的情况，通常意味着只添加了新 listener，却没有移除旧 listener。

### 6. 观察 DOM 身份是否复用

在浏览器 Elements 面板中选中 `<main>`，连续点击更新。如果类型不变，它应该仍是原来那个 DOM，只是属性和部分子节点变化。

---

## 二十一、当前实现的边界与局限

一个好的面试回答不仅要说“我实现了什么”，还要知道“还没实现什么”。

### 1. 只有一个全局 root

`currentRoot`、`wipRoot` 都是全局单例。如果同时向多个 container 渲染，应该为每个 container 维护自己的 root 状态。

### 2. 没有 key 与移动 Diff

列表只按位置复用，不能识别数据项的稳定身份。

### 3. 没有 Hooks 和组件状态

示例中的 `demoCount` 是外部全局变量，不是 `useState`。要实现 Hooks，需要在函数组件 Fiber 上保存 hook 队列和当前 hook 索引。

### 4. 没有真正的优先级模型

所有 Fiber 工作都是同一优先级。真正的调度器会区分用户输入、动画、普通更新等工作的紧急程度。

### 5. 没有被更高优先级工作抢占后的完整重启策略

当前实现可以在空闲回调之间暂停，但没有 lane、过期时间、优先级队列等结构。

### 6. commit 没有拆分成更精细的子阶段

真正 React 的 commit 会包含多种 effect 处理时机。学习版只是简单地处理 DOM 增删改。

### 7. 没有 effect list 或子树标志优化

我们 commit 时会走整棵新树。更成熟的实现可以通过子树 effect 标志快速跳过完全没有变化的分支。

### 8. DOM 属性规则仍然是简化版

HTML、SVG、表单控件、布尔属性、命名空间与特殊属性有很多细节。当前 `updateDom` 适合学习和一般示例，不能当作生产级 DOM renderer。

### 9. 没有错误边界

如果函数组件抛出错误，当前工作循环会直接中断，没有 Error Boundary 去接管失败子树。

### 10. 没有服务端渲染和 hydration

它只会在浏览器中从头创建 DOM，不会复用服务器返回的 HTML。

---

## 二十二、面试时可以怎么讲

如果面试官问“你怎么理解虚拟 DOM 和 Fiber”，可以按下面的顺序回答。

### 第一层：先讲虚拟 DOM

> JSX 会被编译成创建元素的函数调用，最后得到包含 type、props 和 children 的普通 JavaScript 对象。这个对象描述了目标 UI，但它本身不是真实 DOM。

### 第二层：再讲 Fiber 为什么出现

> 如果用普通递归一次性处理很大的元素树，主线程会长时间被占用。Fiber 将树节点改造成通过 parent、child、sibling 连接的工作单元，处理完一个单元就可以检查是否需要让出主线程，之后再从 nextUnitOfWork 恢复。

### 第三层：讲新旧树和 Diff

> 已经提交的 Fiber 树保存在 currentRoot，本次正在构建的树是 wipRoot。新 Fiber 通过 alternate 连到对应旧 Fiber。在协调子节点时，同位置、同类型就复用 DOM 并标记 UPDATE；新节点标记 PLACEMENT；不再需要的旧 Fiber 放进 deletions。

### 第四层：讲 render 和 commit

> Fiber 树的构建和 Diff 属于 render 阶段，可以被时间切片中断，期间不修改用户正在看的 DOM。整棵树构建完成后才进入 commit 阶段，根据 effectTag 一次性完成 DOM 增删改，从而避免展示半成品。

### 第五层：主动说明简化点

> 我手写的学习版 Diff 只按同层位置和 type 判断，还没有 key、Hooks 和真正的优先级调度。requestIdleCallback 只是用来演示可中断思路，不等于 React 真正的 Scheduler。

这样回答的好处是：既能把主线说清楚，也不会把学习代码误说成 React 生产实现。

---

## 二十三、建议按这个顺序自己重写一遍

如果只是通读完整代码，很容易产生“看懂了，但从空文件开始就不会写”的情况。最好将代码分七轮重写。

### 第一轮：只做虚拟 DOM

1. 实现 `createElement`；
2. 实现 `createTextElement`；
3. 打印嵌套元素；
4. 确认所有文本都被归一化。

这轮暂时不要写 Fiber。

### 第二轮：只做首次渲染

1. 为元素创建 DOM；
2. 创建根 Fiber；
3. 用 child、sibling、parent 连成 Fiber 树；
4. 不做 Diff，所有节点都当作 `PLACEMENT`；
5. commit 到 container。

这轮的目标是看到页面。

### 第三轮：加入时间切片

1. 实现 `nextUnitOfWork`；
2. 实现 `performUnitOfWork`；
3. 用显式指针代替递归构建；
4. 实现 `workLoop`；
5. 观察工作是否可以暂停后继续。

### 第四轮：加入新旧树

1. 增加 `currentRoot`；
2. 新 root 的 `alternate` 指向旧 root；
3. 同类型时复用 DOM；
4. 保存 Fiber 级别的 `alternate`。

### 第五轮：加入三种 effect

1. `PLACEMENT`；
2. `UPDATE`；
3. `DELETION`；
4. 专门测试新节点比旧节点少的情况。

### 第六轮：完善 DOM Diff

1. 普通 property；
2. 自定义 attribute；
3. style；
4. 事件的添加、替换和移除；
5. 中间节点替换后的插入位置。

### 第七轮：加入函数组件

1. 判断 `typeof fiber.type === "function"`；
2. 执行组件函数；
3. 让返回元素参与协调；
4. commit 时跳过没有 DOM 的 Fiber；
5. 删除时处理函数组件的多个 DOM 子分支。

完成这七轮后，你对整个流程的记忆会比单纯背一份完整代码牢固得多。

---

## 二十四、可以继续实现的练习

### 练习 1：实现 `useState`

思路提示：

1. 在开始执行函数组件前，记录当前 `wipFiber`；
2. 每个函数组件 Fiber 保存 `hooks` 数组；
3. 用 `hookIndex` 记录当前调用到第几个 Hook；
4. 通过 `alternate.hooks[hookIndex]` 读取旧状态；
5. `setState` 将 action 放入队列，再从 `currentRoot` 创建新 `wipRoot`。

这个练习会让你真正理解为什么 Hook 不能放在条件语句中。因为学习版往往是通过调用顺序和索引对应新旧 Hook。

### 练习 2：实现 key Diff

为列表元素增加 `key`，对旧兄弟 Fiber 建立 Map，再区分复用、移动、新增和删除。

务必用输入框列表测试，因为输入框的 DOM 内部状态能很容暴露错误复用。

### 练习 3：实现 Fragment

Fragment 与函数组件类似，自己没有 DOM，只负责容纳多个子节点。这可以继续检验 commit 和 deletion 对“无 DOM Fiber”的处理是否健壮。

### 练习 4：为每个 Fiber 记录调试日志

输出：

```text
beginWork: App
beginWork: main
beginWork: h1
completeWork: h1
...
commit: UPDATE p
commit: DELETION li
```

然后手工画出遍历路径。这对理解“向下进入 child，完成后向上回溯”非常有帮助。

### 练习 5：模拟更小的时间片

可以临时让每个 `workLoop` 只执行一个 `performUnitOfWork`，并打印 `nextUnitOfWork`。

这样你能非常直观地看到 Fiber 结构如何在没有依赖函数调用栈的情况下恢复工作。

---

## 二十五、最后用一段话串起整个实现

JSX 经过编译会调用 `createElement`，生成包含 `type`、`props` 和 `children` 的虚拟 DOM。`render` 不会直接递归修改页面，而是先创建 `wipRoot`，并将它设为 `nextUnitOfWork`。工作循环在空闲时间中每次处理一个 Fiber，通过 `child`、`sibling` 和 `parent` 寻找下一个工作单元，因此工作可以在时间片结束时暂停，后面再继续。

处理每个 Fiber 时，系统会调和它的子节点：同位置且同类型就复用旧 DOM，创建标记为 `UPDATE` 的新 Fiber；新元素没有可复用的旧 Fiber 就标记为 `PLACEMENT`；旧 Fiber 不再需要就放入 `deletions`。新 Fiber 通过 `alternate` 指向旧 Fiber，从而能在更新时读取旧 props 和复用旧 DOM。

整个 render 阶段只构建新 Fiber 树和准备 effect，不把半成品显示给用户。当 `nextUnitOfWork` 变成 `null` 后，系统进入 commit 阶段，先处理删除，再遍历新树，把新 DOM 插入正确位置，并对复用 DOM 执行属性、style 和事件 Diff。提交完成后，`wipRoot` 变成 `currentRoot`，作为下一次更新的旧树。

当你能不看代码，用自己的话把上面这三段完整讲出来，并能手写 `performUnitOfWork`、`reconcileChildren` 和 `commitWork` 的骨架时，就已经真正掌握了这个迷你 Fiber 实现的主线。
