// VDOM 描述页面长什么样。

// Fiber 保存每个节点的工作信息和新旧关系。

// Render 阶段构建 Fiber、计算变化，不立即显示。

// Commit 阶段根据标记，真正新增、更新和删除 DOM。

// vdom
const myReact = {
  createElement(type, props, ...children) {
    return {
      type,
      props: {
        ...props,
        children: children.map((i) =>
          typeof i === "object" ? i : i.createTextElement(i),
        ),
      },
    };
  },

  createTextElement(text) {
    return {
      type: "TEXT_ELEMENT",
      props: {
        nodeValue: text,
        children: [],
      },
    };
  },
};

// const vdom = myReact.createElement(
//   "div",
//   { id: "0060" },
//   React.createElement("span", null, "hello, React."),
// );

// console.log(vdom);

// fiber
let nextUnitOfWork = null;
let currentRoot = null;
let wipRoot = null;
let deletions = null;

function render(element, container) {
  wipRoot = {
    dom: container,
    props: {
      children: [element],
    },
    alternate: currRoot,
  };
  nextUnitOfWork = wipRoot;
  deletions = [];
}

// 创建 Fiber
function createFiber(element, parent) {
  return {
    type: element.type,
    props: element.props,
    parent,
    dom: null,
    child: null,
    sibling: null,
    alternate: null,
    effectTag: null,
  };
}

// 创建 DOM
function createDom(fiber) {
  const dom =
    fiber.type === "TEXT_ELEMENT"
      ? document.createTextNode("")
      : document.createElement(fiber.type);
}

// 更新 DOM 节点属性
function updateDom(dom, prevProps, nextProps) {
  Object.keys(prevProps)
    .filter((name) => name !== "children")
    .forEach((name) => {
      dom[name] = "";
    });

  Object.keys(nextProps)
    .filter((name) => name !== "children")
    .filter((name) => prevProps[name] !== nextProps[name])
    .forEach((name) => {
      dom[name] = nextProps[name];
    });
}

function workLoop(deadline) {
  let shouldYield = false; // 让出控制权给浏览器

  while (nextUnitOfWork && !shouldYield) {
    nextUnitOfWork = performUnitOfWork(nextUnitOfWork);
    shouldYield = deadline.timeRemaining() < 1;
  }

  if (!nextUnitOfWork && wipRoot) {
    commitRoot();
  }

  requestIdleCallback(workLoop);
}

requestIdleCallback(workLoop);

/*
  处理一个 Fiber 工作单元：

  1. 如果 Fiber 还没有真实 DOM，则创建对应的 DOM
  2. 根据当前 Fiber 的 children 创建或协调子 Fiber
  3. 返回下一个工作单元：
     - 优先返回 child
     - 返回 sibling
     - 沿 parent 向上查找可用的 sibling
     - 整棵树遍历完成后返回 null
*/

function performUnitOfWork(fiber) {
  if (!fiber.dom) fiber.dom = createDom(fiber);

  const elements = fiber.props.children;
  reconcileChildren(fiber, elements);

  if (fiber.child) {
    return fiber.child;
  }

  let nextFiber = fiber;
  while (nextFiber) {
    if (nextFiber.sibling) return nextFiber.sibling;
    nextFiber = nextFiber.parent;
  }
  return null;
}

// diff 算法
function reconcileChildren(wipFiber, elements) {
  let index = 0; //
  let oldFiber = wipFiber.alternate && wipFiber.alternate.child; // 旧的 Fiber 树
  let prevSibling = null;

  while (index < elements.length || oldFiber != null) {
    const element = elements[index];
    let newFiber = null;

    // 比较旧 Fiber 和新元素
    const sameType = oldFiber && element && element.type === oldFiber.type;

    //如果是同类型的节点，复用
    if (sameType) {
      newFiber = {
        type: oldFiber.type,
        props: element.props,
        dom: oldFiber.dom,
        parent: wipFiber,
        alternate: oldFiber,
        effectTag: "UPDATE",
      };
    }

    //如果新节点存在，但类型不同，新增fiber节点
    if (element && !sameType) {
      newFiber = createFiber(element, wipFiber);
      newFiber.effectTag = "PLACEMENT";
    }

    //如果旧节点存在，但新节点不存在，删除旧节点
    if (oldFiber && !sameType) {
      oldFiber.effectTag = "DELETION";
      deletions.push(oldFiber);
    }

    //移动旧fiber指针到下一个兄弟节点
    if (oldFiber) {
      oldFiber = oldFiber.sibling;
    }

    // 将新fiber节点插入到DOM树中
    if (index === 0) {
      //将第一个子节点设置为父节点的子节点
      wipFiber.child = newFiber;
    } else if (element) {
      //将后续子节点作为前一个兄弟节点的兄弟
      prevSibling.sibling = newFiber;
    }

    //更新兄弟节点
    prevSibling = newFiber;
    index++;
  }
}
