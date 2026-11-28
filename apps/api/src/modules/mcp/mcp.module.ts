import { Module } from '@nestjs/common';
import { DeviceModule } from '../device/device.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { McpAuthGuard } from './mcp-auth.guard.js';
import { McpAuthService } from './mcp-auth.service.js';
import { McpToolRegistry } from './mcp-tool-registry.js';
import { McpController } from './mcp.controller.js';
import { McpService } from './mcp.service.js';
import { WhoamiTool } from './tools/whoami.tool.js';

/**
 * Endpoint MCP `/api/v1/mcp` (M6.3). Thêm tool mới: tạo file trong `tools/`, khai báo provider ở đây
 * (tool tự đăng ký vào `McpToolRegistry`). Xem README.md.
 */
@Module({
  imports: [DeviceModule, ProjectsModule],
  controllers: [McpController],
  providers: [
    McpAuthService,
    McpAuthGuard,
    McpToolRegistry,
    McpService,
    WhoamiTool,
  ],
})
export class McpModule {}
