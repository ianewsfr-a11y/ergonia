import type { Env, GuildRow } from "./types.js";
import { json } from "./util.js";

export async function handleListGuilds(env: Env): Promise<Response> {
  const rs = await env.DB
    .prepare("SELECT id, slug, name, description, created_at FROM guilds ORDER BY id ASC")
    .all<GuildRow>();
  return json({ guilds: rs.results ?? [] });
}

export async function findGuildBySlug(env: Env, slug: string): Promise<GuildRow | null> {
  return (
    (await env.DB
      .prepare("SELECT id, slug, name, description, created_at FROM guilds WHERE slug = ?")
      .bind(slug)
      .first<GuildRow>()) ?? null
  );
}
