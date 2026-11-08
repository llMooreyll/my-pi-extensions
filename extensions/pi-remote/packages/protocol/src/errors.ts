export type ErrorCode =
  | "bad_request"          // 参数缺失或类型错误
  | "unauthorized"
  | "not_found"            // processId / uiId / entryId 不存在
  | "busy"                 // 需要空闲但 agent 正在运行
  | "busy_need_deliver_as" // 运行中发消息但没指定 steer/followUp
  | "replacing"            // 进程正在切换会话，稍后重试
  | "conflict_live_elsewhere" // 目标会话已在别的进程中打开
  | "model_no_image"       // 当前模型不支持图片输入
  | "no_model"
  | "no_auth"              // setModel 返回 false
  | "spawn_failed"
  | "spawn_timeout"
  | "bridge_gone"          // 请求期间 pi 进程退出
  | "timeout"
  | "incompatible"         // 协议版本不匹配
  | "unsupported"
  | "no_device"            // no phone is paired with this computer
  | "file_denied"          // path on the deny list or not a regular file / directory
  | "file_too_large"
  | "no_space"
  | "missing"              // file does not exist
  | "internal";

export interface RemoteError { code: ErrorCode; message: string }
