import {
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { createDatabase, type Database } from './client.js';

/** Token inject Drizzle: `@Inject(DB) private readonly db: Database`. */
export const DB = Symbol('DB');
const CONNECTION = Symbol('DB_CONNECTION');

type Connection = ReturnType<typeof createDatabase>;

@Injectable()
class DbShutdown implements OnApplicationShutdown {
  constructor(@Inject(CONNECTION) private readonly connection: Connection) {}

  async onApplicationShutdown(): Promise<void> {
    await this.connection.sql.end({ timeout: 5 });
  }
}

@Global()
@Module({
  providers: [
    {
      provide: CONNECTION,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): Connection =>
        createDatabase(config.get('DATABASE_URL', { infer: true })),
    },
    {
      provide: DB,
      inject: [CONNECTION],
      useFactory: (connection: Connection): Database => connection.db,
    },
    DbShutdown,
  ],
  exports: [DB],
})
export class DbModule {}
