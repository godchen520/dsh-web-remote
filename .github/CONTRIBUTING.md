# Contributing

感谢你对 dsh-web-remote 的关注！

## 开发环境

```bash
# 克隆仓库
git clone https://github.com/godchen520/dsh-web-remote.git
cd dsh-web-remote

# 安装依赖
pnpm install

# 语法检查
node --check lib/index.mjs

# 运行集成测试
node test/test-dist.mjs
```

## 项目结构

```
dsh-web-remote/
├── lib/
│   └── index.mjs          # 主插件代码（Host 端 + Client 注入脚本）
├── test/
│   └── test-dist.mjs      # 集成测试
├── docs/                   # 截图
├── cordis.patch.yml        # DSH composition 配置
├── package.json            # NPM 包配置
└── README.md
```

## 提交规范

- `feat:` 新功能
- `fix:` 修复
- `docs:` 文档
- `chore:` 构建/工具

## 提交 PR

1. Fork 本仓库
2. 创建特性分支：`git checkout -b feat/my-feature`
3. 提交更改：`git commit -m 'feat: add xxx'`
4. 推送分支：`git push origin feat/my-feature`
5. 创建 Pull Request

## 测试

修改 `lib/index.mjs` 后：

```bash
# 1. 语法检查
node --check lib/index.mjs

# 2. 复制到运行副本
cp lib/index.mjs $DSH_HOME/profiles/web/node_modules/dsh-web-remote/lib/index.mjs

# 3. 重启 DSH 验证
```

## 问题反馈

使用 [Issue 模板](../../issues/new/choose) 提交问题或功能请求。
