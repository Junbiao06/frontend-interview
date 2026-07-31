好，我们开始面试。

第一题：请你用 2～3 分钟介绍一下 `co-docs-editor` 项目，重点说明：

- 项目的整体架构和技术选型；
- React、Next.js、Convex、Liveblocks 之间如何协作；
- 你在项目中遇到的最困难问题，以及如何解决。

请开始回答。

好的，我介绍一下 co-docs-editor 这个项目。

这是我独立开发的一个多人实时协作文档编辑器，整体体验类似轻量版的 Google Docs。项目采用 Next.js 16、React 19 和 TypeScript，使用 App Router 组织页面和路由。UI 部分使用 shadcn/ui，富文本编辑器使用 Tiptap，用户认证使用 Clerk，文档元数据和权限相关的数据使用 Convex，实时协作、在线成员、评论线程以及共享布局状态使用 Liveblocks，另外使用 Zustand 管理编辑器实例和工具栏之间的状态。

从整体架构来看，我把系统分成了三类数据。第一类是业务数据，比如文档标题、所有者、组织信息和文档索引，这些数据放在 Convex 中管理；第二类是文档实时编辑内容，交给 Liveblocks 的 Room 进行同步，Tiptap 通过 Liveblocks 的扩展接入协同编辑能力；第三类是协作状态，比如在线用户、评论和页面左右边距，则由 Liveblocks 的 Presence、Comments 和 Storage 负责。

具体来说，用户进入文档页面时，Next.js 的服务端页面会先通过 Clerk 验证登录状态，然后获取 Convex Token，预加载 Convex 中的文档数据。客户端拿到数据后，再以文档 ID 作为 Liveblocks Room ID 加入协作房间。React 负责渲染编辑器、工具栏、导航栏、标尺和评论等界面；Tiptap 负责富文本编辑能力；Liveblocks 负责把编辑操作同步给其他用户。Convex 主要负责文档列表、搜索、分页、标题修改以及文档权限判断。这样可以把相对稳定的业务数据和高频变化的协作数据分开处理。

这个项目中我遇到的最困难的问题，是 Clerk、Convex 和 Liveblocks 之间的多阶段鉴权。最开始如果只在前端页面判断权限，用户理论上可以通过猜测文档 ID，直接请求 Liveblocks 的鉴权接口加入房间。因此我在三个位置都做了校验：首先，Next.js 服务端页面通过 Clerk 保护路由；其次，Convex 的查询和修改函数中，统一根据当前用户的 subject、ownerId 和 organizationId 判断用户是否属于文档所有者或组织成员；最后，在 Liveblocks 鉴权接口中再次使用 Clerk 身份获取 Convex Token，并调用 Convex 的 `getById` 校验文档访问权限，只有校验成功后才给当前用户授予对应 Room 的权限。

这样即使用户绕过页面直接请求 Liveblocks 接口，也无法仅凭文档 ID 越权加入协作房间。通过这次实践，我对前后端数据流、服务端与客户端边界，以及实时协作场景下的权限控制有了比较深入的理解。