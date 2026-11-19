const steps = ['check','runtime','tools','download','dependencies','start','complete'];
const labels = ['检查系统','检测与安装 Node.js','检测与安装基础工具','下载并校验节点','安装并验证组件','启动并验证连接','安装完成'];
const issues = {
  network:'网络连接失败。检查网络后再次执行安装命令，已下载的内容会保留。',
  permission:'需要本机管理员授权。请回到终端完成密码或系统授权。',
  tools:'请查看终端中的工具安装提示；如有系统安装弹窗，请先完成它。',
  download:'下载未完成。再次执行命令会尝试续传，并在下载后校验。',
  integrity:'文件校验未通过，未执行该文件。重新执行命令会重新下载。',
  dependencies:'组件安装或运行验证失败。详情在本机安装日志中，修复后可继续。',
  binding:'无法确认设备绑定。检查网络，或重新生成安装命令后再试。',
  service:'节点尚未完成连接验证。请查看终端提示或本机 node.log 后重试。',
  interrupted:'安装已暂停。再次执行命令可接着已完成的步骤继续。',
  unsupported:'当前系统或后台服务暂不支持自动安装，终端中会显示具体处理方式。',
  unknown:'请查看本机终端的错误提示。再次执行命令会保留已完成的步骤。',
};
export function installationView(record, now = Date.now()) {
  const index=Math.max(0,steps.indexOf(record.step));
  const complete=record.status==='succeeded' && record.online && !!record.device_id;
  if(record.issue==='account_changed')return {title:record.online?'账号已切换 · 设备在线':'账号已切换 · 等待设备上线',detail:'已复用原有节点，任务、工作目录和工具均保留。之前共享的 Context 仍属于原账号。',tone:record.online?'online':'waiting',progress:6,retry:false,complete};
  if(complete)return {title:'安装完成 · 设备在线',detail:'本机服务和云端连接均已验证，可以开始工作。',tone:'online',progress:6,retry:false,complete:true};
  if(record.issue==='account_kept')return {title:'已保留原账号绑定',detail:'可登录原账号继续使用这台设备。当前账号下的其他设备也可直接进入。',tone:'waiting',progress:index,retry:false,complete:false};
  if(record.expires<=now)return {title:'安装命令已过期',detail:'重新生成命令即可继续，本机已完成的下载和安装会保留。',tone:'failed',progress:index,retry:true,complete:false};
  if(record.issue==='account'){
    const conflict=record.account_conflict;
    return {title:conflict?`${conflict.device_name} 已绑定 ${conflict.from_username}`:'设备绑定需要重新确认',detail:conflict?`可保留原绑定，或切换到 ${conflict.to_username}。切换后原账号无法再访问此设备；本机任务和文件保留，已共享 Context 的归属不变。`:'绑定信息已变化，请重新生成并执行安装命令。',tone:'waiting',progress:index,retry:!conflict,complete:false};
  }
  if(record.status==='pending')return {title:'等待在本机执行命令',detail:'请在 10 分钟内开始；开始后可在 24 小时内继续。',tone:'waiting',progress:0,retry:false,complete:false};
  if(record.status==='succeeded')return {title:'安装已完成 · 等待设备重新上线',detail:'请确认设备已开机并联网，节点会自动重连。',tone:'waiting',progress:6,retry:false,complete:false};
  const failed=['failed','paused'].includes(record.status);
  const waiting=record.status==='waiting';
  const stale=now-record.updated_at>120000;
  return {title:`${failed ? '安装暂停' : waiting ? '需要本机操作' : '正在安装'} · ${labels[index]}`,
    detail:failed || waiting ? (issues[record.issue] || issues.unknown) : stale ? '此步骤可能需要一些时间，请查看本机终端。若终端已关闭，再次执行命令即可继续。' : '正在本机执行，详细过程可在终端查看。',
    tone:failed ? 'failed' : 'waiting',progress:index,retry:failed || stale,complete:false};
}
