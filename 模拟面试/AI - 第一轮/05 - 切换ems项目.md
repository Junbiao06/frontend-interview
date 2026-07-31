这部分回答比较扎实，尤其是能主动指出当前订阅整个 Store 会带来额外重渲染，说明你区分了“能运行”和“性能最优”。

下面切换到 EMS 项目。

假设员工登录后请求“查询工资单”接口，并且手动把请求参数中的 `employeeId` 改成其他员工的 ID。请你完整说明这个请求经过哪些后端层、每一层做什么校验，以及系统如何保证员工只能查询自己的工资单、管理员可以查询授权范围内的数据。

另外，为什么不能只依赖前端 React Context 中保存的角色信息？

我会先区分“查询工资单列表”和“按工资单 ID 查询详情”两个接口，因为当前项目这两个接口的权限处理并不完全一样。

以列表接口 `GET /api/payslips` 为例，请求流程如下：

1. 路由层匹配到 `payslipRouter.get("/", protect, getPayslip)`，先经过 `protect` 中间件。

2. `protect` 从 `Authorization: Bearer xxx` 中取出 JWT，并使用服务端的 `JWT_SECRET` 验证签名和有效期。验证失败返回 401；验证成功后，将 JWT 中的 `userId`、`role` 和 `email` 放入 `req.session`。

3. Controller 中根据服务端解析出来的 `req.session.role` 分支处理。管理员会查询全部工资单，并通过 `populate("employeeId")` 获取员工信息。当前项目的角色模型只有管理员和普通员工，因此管理员的授权范围是系统内全部工资单。

4. 如果是普通员工，后端不会使用前端传过来的 `employeeId`。它会根据 JWT 中的 `userId` 查询员工：

```ts
Employee.findOne({ userId: req.session.userId })
```

拿到当前登录用户对应的 `employee._id` 后，再执行：

```ts
PaySlip.find({ employeeId: employee._id })
```

所以员工即使手动把请求中的 `employeeId` 改成其他人的 ID，列表接口也不会按照这个参数查询，因为后端根本不信任这个参数，而是通过 JWT 用户身份反查员工 ID。

数据模型层面，`Employee.userId` 是唯一关联到 `User` 的字段，`PaySlip.employeeId` 关联到 `Employee`，这就形成了：

```text
JWT.userId → Employee.userId → Employee._id → PaySlip.employeeId
```

这个映射链路保证员工只能获取与自己绑定的工资单。

不过，按当前代码来看，`GET /api/payslips/:id` 这个详情接口还存在一个权限缺口。它目前只经过 `protect`，然后直接根据 `req.params.id` 查询工资单，没有再次判断该工资单是否属于当前员工。也就是说，如果普通员工能够猜到其他工资单的 ID，理论上可能通过详情接口访问别人的工资单。因此严格来说，当前项目的列表接口具备归属校验，但详情接口还需要补强。

我会把详情查询改成带数据范围的查询。管理员可以按 ID 查询；普通员工则先根据 `req.session.userId` 找到自己的 `employee._id`，然后使用组合条件：

```ts
PaySlip.findOne({
  _id: req.params.id,
  employeeId: employee._id,
});
```

这样即使员工修改 URL 中的工资单 ID，也只能查到属于自己的记录。没有权限时可以统一返回 404，避免泄露该工资单是否存在；或者返回 403 表示无权访问。

管理员的范围如果以后不应该是全部数据，也不能只依赖 `role === "ADMIN"`，而应该在用户或员工数据中增加部门、组织等授权字段，然后在 Service 或查询条件中加入对应的数据范围过滤。

最后，不能只依赖前端 React Context 中保存的角色信息。Context 只负责界面展示和路由控制，例如决定是否显示“生成工资单”按钮。用户可以通过 DevTools 修改 Context、绕过前端路由，甚至直接使用 Postman 请求接口。如果后端相信前端传来的角色或 `employeeId`，就会产生越权。

真正的权限依据必须来自服务端验证过的 JWT，数据归属还必须在数据库查询条件中再次校验。前端 Context 是用户体验层的状态，后端 JWT 和数据库权限判断才是安全边界。