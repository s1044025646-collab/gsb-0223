import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { createApp } from './server.js';
import { Store } from './store.js';

function findFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolvePort(port));
      } else {
        reject(new Error('无法获取空闲端口'));
      }
    });
  });
}

async function main(): Promise<void> {
  const dataDir = process.env.JSONPATCH_DATA_DIR ?? resolve(process.cwd(), 'data');
  const dbPath = resolve(dataDir, 'jsonpatch.db');
  const store = new Store(dbPath);
  const app = createApp(store);

  let port: number;
  const portEnv = process.env.PORT;
  if (portEnv && /^\d+$/.test(portEnv)) {
    port = Number(portEnv);
  } else {
    port = await findFreePort();
  }

  app.listen(port, '127.0.0.1', () => {
    console.log(`JSON Patch 修订服务已启动`);
    console.log(`监听地址: http://127.0.0.1:${port}`);
    console.log(`数据目录: ${dataDir}`);
  });

  const shutdown = (): void => {
    app.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
