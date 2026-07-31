`dependencies` 和 `devDependencies` 都是项目依赖，区别主要在于：**生产环境运行是否需要它**。

## 1. dependencies：生产依赖

项目上线后，运行程序仍然需要的包。

安装：

```bash
npm install 包名
```

会记录在：

```json
{
  "dependencies": {
    "react": "^19.0.0",
    "express": "^5.0.0"
  }
}
```

全栈项目常见的生产依赖：

### 前端运行

```text
react
react-dom
next
react-router-dom
zustand
axios
swr
dayjs
lodash
zod
react-hook-form
lucide-react
```

这些包会被业务代码直接使用，例如：

```js
import axios from "axios";
import { create } from "zustand";
```

### 后端运行

```text
express
cors
dotenv
jsonwebtoken
bcrypt
mongoose
prisma客户端
socket.io
resend
```

例如服务器启动后仍然要使用 Express、Mongoose，因此属于 `dependencies`。

### UI 和功能库

```text
@radix-ui/*
class-variance-authority
clsx
tailwind-merge
react-markdown
remark-gfm
```

这些也会参与实际页面运行，一般放在 `dependencies`。

---

## 2. devDependencies：开发依赖

只在开发、检查、测试或者构建过程中使用，应用正式运行时通常不需要。

安装：

```bash
npm install 包名 --save-dev
```

简写：

```bash
npm install -D 包名
```

会记录在：

```json
{
  "devDependencies": {
    "typescript": "^5.0.0",
    "eslint": "^9.0.0"
  }
}
```

全栈项目常见的开发依赖：

### TypeScript 相关

```text
typescript
tsx
ts-node
@types/node
@types/react
@types/react-dom
@types/express
```

`@types/*` 只负责类型提示和类型检查，不参与程序运行，所以通常放在 `devDependencies`。

### 代码检查和格式化

```text
eslint
prettier
eslint-config-next
eslint-plugin-react
```

### 构建工具

```text
vite
webpack
rollup
esbuild
nodemon
```

### CSS 构建工具

```text
tailwindcss
postcss
autoprefixer
```

它们通常只在构建 CSS 时使用，所以一般放在 `devDependencies`。

### 测试工具

```text
vitest
jest
playwright
cypress
@testing-library/react
```

---

## 3. 按前端全栈项目分类

|分类|常见依赖|一般放置|
|---|---|---|
|前端框架|React、Next.js、Vue|`dependencies`|
|路由|react-router-dom|`dependencies`|
|状态管理|Zustand、Redux Toolkit|`dependencies`|
|请求与缓存|Axios、SWR、TanStack Query|`dependencies`|
|表单与校验|react-hook-form、Zod|`dependencies`|
|UI 组件|Radix UI、Lucide React|`dependencies`|
|后端框架|Express、Fastify、NestJS|`dependencies`|
|数据库|Mongoose、Prisma Client|`dependencies`|
|身份认证|Clerk、JWT、bcrypt|`dependencies`|
|实时通信|Socket.IO、Yjs|`dependencies`|
|TypeScript|typescript、tsx|`devDependencies`|
|类型声明|`@types/*`|`devDependencies`|
|代码规范|ESLint、Prettier|`devDependencies`|
|构建工具|Vite、Webpack|`devDependencies`|
|开发热更新|nodemon|`devDependencies`|
|测试工具|Vitest、Jest、Playwright|`devDependencies`|

## 4. 最简单的判断方法

问自己一句：

> 项目构建完成以后，正式运行时还需要这个包吗？

- 需要：`dependencies`
    
- 只用于开发、构建、类型检查、代码检查或测试：`devDependencies`
    

例如：

```bash
npm install express mongoose zod
npm install -D typescript tsx nodemon @types/express
```

一个典型的全栈项目可能是：

```json
{
  "dependencies": {
    "express": "^5.0.0",
    "mongoose": "^8.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/node": "^24.0.0",
    "@types/react": "^19.0.0",
    "eslint": "^9.0.0",
    "nodemon": "^3.0.0",
    "typescript": "^5.0.0",
    "vite": "^7.0.0"
  }
}
```

注意：字段名是复数形式 `dependencies` 和 `devDependencies`。