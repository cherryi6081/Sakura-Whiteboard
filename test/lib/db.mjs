import crypto from "node:crypto";
import pg from "pg";
import { DATABASE_URL } from "./config.mjs";

/** 测试直连 dev 库；只用于核对落库事实（审计行、时间老化、软删用户等） */
export const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });

export function query(text, params) {
  return pool.query(text, params);
}

export async function userIdByEmail(email) {
  const { rows } = await query("select id from users where email = $1", [email]);
  if (!rows[0]) throw new Error(`用户不存在：${email}`);
  return rows[0].id;
}

export async function boardsOfOwner(userId) {
  const { rows } = await query(
    `select id, title, pinned_at, deleted_at, opened_count, last_opened_at, created_at, last_edited_at
       from boards
      where owner_id = $1
      order by created_at asc, id asc`,
    [userId],
  );
  return rows;
}

/** 把某用户全部板的时间推到窗口外，让它们可被淘汰 */
export async function ageBoards(userId, minutes = 11) {
  await query(
    `update boards
        set created_at = now() - ($2::int * interval '1 minute'),
            last_edited_at = now() - ($2::int * interval '1 minute'),
            last_opened_at = case when last_opened_at is null then null else now() - ($2::int * interval '1 minute') end
      where owner_id = $1`,
    [userId, minutes],
  );
}

export async function evictions(ownerId) {
  const { rows } = await query("select * from board_evictions where owner_id = $1 order by evicted_at asc", [ownerId]);
  return rows;
}

export async function evictionsForGuest(guestId) {
  const { rows } = await query(
    "select * from board_evictions where owner_guest_id = $1 order by evicted_at asc",
    [guestId],
  );
  return rows;
}

export async function guestIdOfBoard(boardId) {
  const { rows } = await query("select owner_guest_id from boards where id = $1", [boardId]);
  return rows[0]?.owner_guest_id ?? null;
}

export async function boardRow(boardId) {
  const { rows } = await query("select * from boards where id = $1", [boardId]);
  return rows[0] ?? null;
}

export async function disableUser(userId) {
  await query("update users set status = 'disabled' where id = $1", [userId]);
}

export async function expireShare(linkId) {
  await query("update share_links set expires_at = now() - interval '1 minute' where id = $1", [linkId]);
}

export async function opsCount(boardId) {
  const { rows } = await query("select count(*)::int as n from board_ops where board_id = $1", [boardId]);
  return rows[0].n;
}

export async function liveElements(boardId) {
  const { rows } = await query(
    "select element_id, type, is_deleted from elements where board_id = $1 order by element_id",
    [boardId],
  );
  return rows;
}

/** 同板写入过的不同身份数（登录取 user_id，游客取 guest_id） */
export async function opActors(boardId) {
  const { rows } = await query(
    "select count(distinct coalesce(user_id::text, guest_id))::int as n from board_ops where board_id = $1",
    [boardId],
  );
  return rows[0].n;
}

/** 直接落一条已过期的分享链接（不经过接口，避免创建时写入的 60s 缓存影响过期判定） */
export async function insertExpiredShare(boardId, token) {
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  await query(
    `insert into share_links (board_id, token_hash, permission, created_by, expires_at)
     select $1, $2, 'read', owner_id, now() - interval '1 minute' from boards where id = $1`,
    [boardId, hash],
  );
  return hash;
}

export async function closePool() {
  await pool.end();
}
