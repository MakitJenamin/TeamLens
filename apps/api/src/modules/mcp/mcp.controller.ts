import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../../common/auth-context.js';
import { McpAuthGuard } from './mcp-auth.guard.js';
import { McpService } from './mcp.service.js';
import type { McpRequest } from './mcp.types.js';

/**
 * Endpoint MCP duy nhất (contract `mcp.yaml`). `@Public()` để bỏ qua guard cookie/thiết bị của app,
 * rồi `McpAuthGuard` tự xác thực `tld_` hoặc `tlp_`. Không giữ phiên: `GET` luôn 405, `DELETE` luôn 204.
 */
@Controller('api/v1/mcp')
@Public()
@UseGuards(McpAuthGuard)
export class McpController {
  constructor(private readonly mcp: McpService) {}

  @Post()
  async post(@Req() req: McpRequest, @Res() res: Response): Promise<void> {
    // Guard đã gắn `req.mcp`; `@Res()` nên Nest không tự trả response, transport của SDK trả.
    await this.mcp.handle(req, res, req.mcp!, req.body);
  }

  @Get()
  get(@Res() res: Response): void {
    res
      .status(405)
      .set('Allow', 'POST, DELETE')
      .json({
        error: 'method_not_allowed',
        message: 'Server MCP không mở luồng SSE; dùng POST.',
      });
  }

  @Delete()
  @HttpCode(204)
  delete(@Res() res: Response): void {
    res.status(204).end();
  }
}
