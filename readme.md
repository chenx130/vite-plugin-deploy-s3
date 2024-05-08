# Vite S3 Upload Plugin
一个用于 Vite 的插件，它将 `dist` 目录的打包产物自动上传到 AWS S3。

## 特性
- 🚀 **自动化**: 打包完成后自动上传到 S3。
- 🔒 **安全**: 使用 AWS SDK 进行安全传输。

## 安装
使用 npm 或 yarn 安装插件：
```bash
npm install vite-plugin-deploy-s3 --save-dev

# 或者

yarn add vite-plugin-deploy-s3 --dev
```


## 配置
在你的 vite.config.ts 文件中添加此插件：

```typescript
// vite.config.ts
import Deploy from 'vite-plugin-deploy-s3';

export default defineConfig({
  plugins: [
    Deploy({
      s3: {
        ... // AWS S3 配置
      }
    })
  ]
});
```