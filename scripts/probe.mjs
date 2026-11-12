import { connectExisting } from './cdp.mjs';

const args = process.argv.slice(2);
if (args.length && !(args.length === 2 && args[0] === '--profile-dir')) {
  console.error('用法: node scripts/probe.mjs [--profile-dir "Chrome User Data 根目录"]');
  process.exitCode = 1;
} else {
  let chrome;
  try {
    chrome = await connectExisting(args.length ? { profileDir: args[1] } : {});
    console.log(JSON.stringify({ connected: true, pages: await chrome.pages() }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { chrome?.close(); }
}
