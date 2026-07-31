
Zustand，作为轻量、高效的状态管理库，API 简洁直观，组合中间件、支持可变写法，同时保持性能和可维护性。比起 Redux，心智负担低，入门快，非常适合现代前端开发。

## 01 - 快速入门

```ts
// 官网例子的补充
import { create } from "zustand";

// 状态接口
interface BearState {
  bears: number;
}

// 动作接口
interface BearActions {
  increasePopulation: () => void;
  removeAllBears: () => void;
  updateBears: (newBears: number) => void;
  getBears: () => number;
}

// store 类型
export type BearStore = BearState & BearActions;

// 创建 store7
const useBear = create<BearStore>((set, get) => ({
  bears: 0,
  increasePopulation: () =>
    set((state) => ({ bears: state.bears + 1 })),
  removeAllBears: () => set({ bears: 0 }),
  updateBears: (newBears: number) => set({ bears: newBears }),
  getBears: () => get().bears, // 每次调用获取最新值
}));

export default useBear;
```

## 02 - 状态处理（使用immer库）

> Zustand 的“浅合并（shallow merge）机制”  
`set()` 只会对第一层做浅合并，不会对嵌套对象做深合并，需要使用immer库来实现。

### "浅合并"带来的问题

```ts
import { create } from "zustand";

interface User {
  gourd: {
    oneChild: string;
    twoChild: string;
    threeChild: string;
  };
  updateGourd: () => void;
}

const useUserStore = create<User>((set) => ({
  gourd: {
    oneChild: "大娃",
    twoChild: "二娃",
    threeChild: "三娃",
  },

  // ❌ 这种写法会丢失 twoChild 和 threeChild 的数据
  // updateGourd: () =>
  //   set((state) => ({
  //     gourd: {
  //       oneChild: "大娃-超进化",
  //     },
  //   })),

  // ❌ 对的，但增加心智负担，不好维护（层级嵌套）
  updateGourd: () =>
    set((state) => ({
      gourd: {
        ...state.gourd,
        oneChild: "大娃-超进化",
      },
    })),
}));

export default useUserStore;
```

### 在Zustand中使用immer库

```ts
import { create } from "zustand"
import { immer } from "zustand/middleware/immer"

const useUserStore = create<User>()(
  immer((set) => ({
    gourd: {
      oneChild: "大娃",
      twoChild: "二娃",
      threeChild: "三娃",
    },
    
    // ✅ 直接修改状态，无需手动合并
    updateGourd: () =>
      set((state) => {
        state.gourd.oneChild = "大娃-超进化"
        state.gourd.threeChild = "三娃-我来了"
      }),
  }))
)
```

#### immer原理解析

> 让你用“可变写法”去安全地修改不可变数据，本质上是简化不可变数据的更新。

> immer 的核心原理基于两大概念：写时复制，惰性代理。

immer.js 通过 Proxy 代理对象的所有操作，实现不可变数据的更新。当对数据进行修改时，immer 会创建一个被修改对象的副本，并在副本上进行修改，最后返回修改后的新对象，而原始对象保持不变。这种机制确保了数据的不可变性，同时提供了直观的修改方式。


##### 基本使用

```ts
import { produce } from "immer";

const todos = [
  { title: "Learn JS", done: false },
  { title: "Try Immer", done: false },
];

const nextTodos = produce(todos, (draft) => {
  draft.push({ title: "Subscribe", done: false });
  draft[0].done = true;
});

console.log(nextTodos.length);  // 3

console.log(todos[0].done);     // false
console.log(nextTodos[0].done); // true

nextTodos[1].done = true;       // TypeError: Cannot assign to read only property 'done' of object '#<Object>'
```

##### 源码复刻

```ts
type Draft<T> = {
  -readonly [P in keyof T]: T[P];
};

function produce<T>(base: T, recipe: (draft: Draft<T>) => void): T {
  // 用于存储修改过的对象
  const modified: Record<string, any> = {};
  
  const handler = {
    get(target: any, prop: string) {
      // 如果这个对象已经被修改过，返回修改后的对象
      if (prop in modified) {
        return modified[prop];
      }
      
      // 如果访问的是对象，则递归创建代理
      if (typeof target[prop] === 'object' && target[prop] !== null) {
        return new Proxy(target[prop], handler);
      }
      return target[prop];
    },
    set(target: any, prop: string, value: any) {
      // 记录修改
      modified[prop] = value;
      return true;
    }
  };

  // 创建代理对象
  const proxy = new Proxy(base, handler);
  
  // 执行修改函数
  recipe(proxy);
  
  // 如果没有修改，直接返回原对象
  if (Object.keys(modified).length === 0) {
    return base;
  }
  
  // 创建新对象，只复制修改过的属性
  return JSON.parse(JSON.stringify(proxy))
}
```

## 03 - 状态简化(使用 useShallow 避免不必要渲染)

```ts
// import { create } from "zustand";

// interface BearState {
//   bears: number;
// }
// interface BearActions {
//   increasePopulation: () => void;
//   removeAllBears: () => void;
//   updateBears: (newBears: number) => void;
//   getBears: () => number; 
// }
// export type BearStore = BearState & BearActions;

// const useBearStore = create<BearStore>((set, get) => ({
//   bears: 0,
//   increasePopulation: () => set((state) => ({ bears: state.bears + 1 })),
//   removeAllBears: () => set({ bears: 0 }),
//   updateBears: (newBears: number) => set({ bears: newBears }),
//   getBears: () => get().bears,
// }));

// export default useBearStore;


import useBearStore from '@/stores/useBear';
import { useShallow } from 'zustand/react/shallow';


// ❌ 方法1:直接解构
// 不同组件之间，只要有一个属性发生改变，全部重新渲染
// 当前组件订阅整个 store，因此 store 中任意状态变化都可能导致当前组件重新渲染。
const { bears, increasePopulation } = useBearStore();

// ❌ 方法2:使用选择器
// 增加心智负担
const updateBears = useBearStore((state) => state.updateBears);

// ✅ 方法3:useShallow
const { removeAllBears, bears } = useBearStore(useShallow((state) => ({
    removeAllBears: state.removeAllBears,
    bears: state.bears
})))
```

## 04 - middleware中间件

### 自定义中间件

```ts
/**  
* 创建 store 的配置函数（原始函数，由用户传入，中间件会包装它）  
* @param {function} set - 原始状态更新函数，用于修改 store 的状态  
* @param {function} get - 获取当前 store 的状态值  
* @param {object} api - store 的完整 API，包括 setState、getState、subscribe、destroy 和 actions  
* @returns {StoreApi} 返回一个完整的 store 对象  
*/

const logger = (config) => (set, get, api) => config((...args) => {
    console.log(api)
    console.log('before', get())
    set(...args)
    console.log('after', get())
}, get, api)
```

### devtools/persist/combine

> devtool -> 引入浏览器插件Redux DevTools，实现可视化监控
> persist -> 将数据存到localStorage，useStore.persist.clearStorage 清除持久化
> combine -> 将state和actions分离


#### AI Chat 项目实例
```ts
import { create } from "zustand";
import { persist, combine, createJSONStorage, devtools } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";

interface ChatStoreState {
  currentModel: string;
  hydrated: boolean;
}

interface ChatStoreActions {
  setCurrentModel: (model: string) => void;
  setHydrated: (val: boolean) => void;
}

type ChatStore = ChatStoreState & ChatStoreActions;

// 创建 store
const useChatStore = create<ChatStore>()(
  devtools(
    persist(
      immer(
        combine<ChatStoreState, ChatStoreActions>(
	      // state
          {
            currentModel: "deepseek-ai/DeepSeek-V3.2",
            hydrated: false,
          },
          // actions
          (set) => ({
            setCurrentModel: (model: string) =>
              set((state) => {
                state.currentModel = model;
              }),
            setHydrated: (val: boolean) =>
              set((state) => {
                state.hydrated = val;
              }),
          })
        )
      ),
      {
        // localstorage 的 key
        name: "chat",
        storage: createJSONStorage(() => localStorage),
        // 避免组件在 store 数据还没恢复时渲染空数据或错误 UI
        onRehydrateStorage: () => (state) => {
          state?.setHydrated(true);
        },
        // 部分存入
        partialize: (state) => ({
          currentModel: state.currentModel,
        }),
      }
    ),
    {
	  name: "ChatStore-DevTools", // 默认名称
	  enabled: true, // 是否打开
    }
  )
);

export type { ChatStore };
export default useChatStore;
```

## 05 - subscribe订阅

> 订阅允许在状态变化时执行副作用逻辑，而不会自动触发组件重渲染。

### 基本使用

```tsx
const store = create((set) => ({
  count: 0,
}))

// 全局订阅（没选selector就是订阅整个state）
store.subscribe((state) => {
  console.log(state.count)
})

// 组件内部订阅（没选selector就是订阅整个state）
useEffect(() => {
  store.subscribe((state) => {
    console.log(state.count)
  })
}, [])
```

### 取消订阅

```tsx
import { subscribeWithSelector } from "zustand/middleware"

const store = create(
  subscribeWithSelector((set) => ({
    age: 0,
    name: "张三",
  }))
)

const [status, setStatus] = useState("小孩")

useEffect(() => {
  // 只会更新一次组件
  const unSub = useStore.subscribe(
    // 只监控 age
    (state) => state.age,
    (age, prevAge) => {
      if (age < 18) {
        setStatus("小孩")
        unSub()
      } else {
        setStatus("大人")
      }
    },
    {
      equalityFn: (a, b) => a === b, // 默认是浅比较（只比较引用）
      fireImmediately: true, // 立即触发，默认false
    }
  )
  return () => unSub() // 组件卸载时清理
}, [])
```

## 附录 - Zustand中间件顺序

```ts
import { create } from "zustand";
import {
  devtools,
  persist,
  subscribeWithSelector,
  combine,
} from "zustand/middleware";
import { immer } from "zustand/middleware/immer";


interface AppState {
  count: number;
}

interface AppActions {
  increment: () => void;
}

type AppStore = AppState & AppActions;

const useStore = create<AppStore>()(
  devtools(
    persist(
      immer(
        subscribeWithSelector(
          combine<AppState, AppActions>(
            { count: 0 },
            (set) => ({
              increment: () => {
                set((state) => {
                  state.count += 1;
                });
              },
            })
          )
        )
      ),
      { name: "app" }
    ),
    { name: "AppStore" }
  )
);

export default useStore;
```