/** 中继的 WebSocket 路径。查询参数 hostId、connId 都用 encodeURIComponent */
export const RELAY_PATH_CLIENT = "/v1/client";             // ?hostId=H          App 使用，不带密钥
export const RELAY_PATH_HOST_CONTROL = "/v1/host/control"; // ?hostId=H          hostd 使用，Authorization: Bearer <RELAY_SECRET>
export const RELAY_PATH_HOST_DATA = "/v1/host/data";       // ?hostId=H&connId=C hostd 使用，同上
export const DIRECT_PATH_CLIENT = "/v1/client";            // 直连监听上的路径（无查询参数）

/** 中继 → hostd 控制连接上的文本帧（JSON） */
export type RelayToHost =
  | { t: "client"; connId: string }      // 有一个 App 连接在等待，请为它开一条数据连接
  | { t: "ping"; ts: number };
export type HostToRelay = { t: "pong"; ts: number };

/** WebSocket 关闭码 */
export const CLOSE = {
  HOST_OFFLINE: 4404,        // 中继：该 hostId 没有在线的 hostd
  HOST_REPLACED: 4409,       // 中继：同一 hostId 的新控制连接顶替了旧的
  BAD_RELAY_SECRET: 4401,    // 中继：hostd 的 RELAY_SECRET 不对
  PAIR_TIMEOUT: 4504,        // 中继：hostd 没在 10 秒内接上数据连接
  RATE_LIMITED: 4429,
  UNAUTHORIZED: 4411,        // hostd：设备鉴权失败或被吊销
  AUTH_TIMEOUT: 4408,        // hostd：通道建立后 10 秒内没有 auth/pair
} as const;
