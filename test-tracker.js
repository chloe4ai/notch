// 测试脚本 - 模拟发送活动数据到 LittleJot API
// 运行: node test-tracker.js

import http from 'http';

async function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost',
      port: 4174,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function test() {
  console.log('测试 LittleJot Activity API\n');

  // 1. 发送一些 App 使用记录
  console.log('1. 发送 App 活动记录...');
  const apps = [
    { bundleId: 'com.apple.Safari', name: 'Safari', durationMs: 300000 },
    { bundleId: 'com.apple.Terminal', name: 'Terminal', durationMs: 120000 },
    { bundleId: 'com.apple.Finder', name: 'Finder', durationMs: 60000 },
  ];
  for (const app of apps) {
    await post('/api/activities/apps', app);
    console.log(`   ${app.name}: ${app.durationMs}ms`);
  }

  // 2. 发送心跳
  console.log('\n2. 发送心跳...');
  await post('/api/activities/heartbeat', { running: true });
  console.log('   心跳已发送');

  // 3. 检查状态
  console.log('\n3. 检查 Tracker 状态...');
  const statusReq = await new Promise((resolve, reject) => {
    http.get('http://localhost:4174/api/activities/status', (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
  console.log('   状态:', statusReq);

  // 4. 获取今日活动
  console.log('\n4. 获取今日活动...');
  const actReq = await new Promise((resolve, reject) => {
    http.get('http://localhost:4174/api/activities/2026-05-06', (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
  console.log('   Apps:', actReq.apps?.length || 0);
  console.log('   Keylogs:', actReq.keylogs?.length || 0);
  console.log('   Screenshots:', actReq.screenshots?.length || 0);

  console.log('\n测试完成！打开 http://localhost:4174 查看活动日志面板');
}

test().catch(console.error);
