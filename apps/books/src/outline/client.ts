// Outline の API クライアント。fetch を差し替えられるようにしてあり、テストでは偽物を渡す。
// トークンは環境変数から読み、ログやエラー文に出さない。

export interface OutlineDocument {
  id: string;
  title: string;
  text: string;
  updatedAt: string;
  collectionId?: string;
  parentDocumentId?: string | null;
}

export interface OutlineBrowseItem {
  id: string;
  title: string;
  hasChildren: boolean;
  collection?: string;
}

export interface OutlineAttachment {
  bytes: Uint8Array;
  contentType: string;
}

export interface OutlineClient {
  getDocument(id: string): Promise<OutlineDocument>;
  /** 親文書の直下の子文書を、Outline の並び順で本文付きで返す。 */
  listChildDocuments(parentId: string): Promise<OutlineDocument[]>;
  /** 親を省くと各コレクションの最上位の文書、指定すればその子。 */
  browse(parentId?: string): Promise<OutlineBrowseItem[]>;
  fetchAttachment(id: string): Promise<OutlineAttachment>;
}

export interface OutlineConfig {
  baseUrl: string;
  token: string;
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export class OutlineHttpError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
  ) {
    super(`Outline API ${endpoint} が ${status} を返しました`);
  }
}

/** OUTLINE_URL と OUTLINE_API_TOKEN の両方があるときだけ設定を返す。 */
export function outlineConfigFromEnv(env: Record<string, string | undefined> = process.env): OutlineConfig | null {
  const baseUrl = env.OUTLINE_URL?.trim().replace(/\/+$/, "");
  const token = env.OUTLINE_API_TOKEN?.trim();
  return baseUrl && token ? { baseUrl, token } : null;
}

interface NavigationNode {
  id: string;
  title: string;
  children?: NavigationNode[];
}

const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const CHUNK = 5;

function findNode(nodes: NavigationNode[], id: string): NavigationNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = findNode(n.children ?? [], id);
    if (hit) return hit;
  }
  return null;
}

export function createOutlineClient(config: OutlineConfig, fetchFn: FetchFn = fetch): OutlineClient {
  const origin = new URL(config.baseUrl).origin;

  async function call<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetchFn(`${config.baseUrl}/api/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${config.token}` },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (!response.ok) throw new OutlineHttpError(response.status, endpoint);
    return ((await response.json()) as { data: T }).data;
  }

  const toDocument = (d: Record<string, unknown>): OutlineDocument => ({
    id: String(d.id),
    title: String(d.title ?? ""),
    text: String(d.text ?? ""),
    updatedAt: String(d.updatedAt ?? ""),
    ...(typeof d.collectionId === "string" ? { collectionId: d.collectionId } : {}),
    ...(d.parentDocumentId !== undefined ? { parentDocumentId: d.parentDocumentId as string | null } : {}),
  });

  const getDocument = async (id: string) => toDocument(await call<Record<string, unknown>>("documents.info", { id }));

  const collectionTree = (id: string) => call<NavigationNode[]>("collections.documents", { id });

  async function childNodes(parentId: string): Promise<NavigationNode[]> {
    const parent = await getDocument(parentId);
    if (!parent.collectionId) return [];
    const node = findNode(await collectionTree(parent.collectionId), parentId);
    return node?.children ?? [];
  }

  return {
    getDocument,

    async listChildDocuments(parentId) {
      const nodes = await childNodes(parentId);
      const docs: OutlineDocument[] = [];
      for (let i = 0; i < nodes.length; i += CHUNK) {
        docs.push(...(await Promise.all(nodes.slice(i, i + CHUNK).map((n) => getDocument(n.id)))));
      }
      return docs;
    },

    async browse(parentId) {
      if (parentId) {
        return (await childNodes(parentId)).map((n) => ({
          id: n.id,
          title: n.title,
          hasChildren: (n.children ?? []).length > 0,
        }));
      }
      const collections: { id: string; name: string }[] = [];
      for (let offset = 0; ; offset += 100) {
        const page = await call<{ id: string; name: string }[]>("collections.list", { limit: 100, offset });
        collections.push(...page);
        if (page.length < 100) break;
      }
      const items: OutlineBrowseItem[] = [];
      for (const c of collections) {
        for (const n of await collectionTree(c.id)) {
          items.push({ id: n.id, title: n.title, hasChildren: (n.children ?? []).length > 0, collection: c.name });
        }
      }
      return items;
    },

    async fetchAttachment(id) {
      let url = `${config.baseUrl}/api/attachments.redirect?id=${encodeURIComponent(id)}`;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        // 認証は Outline 自身へのリクエストにだけ付け、署名付き URL など別オリジンへは送らない。
        const sameOrigin = new URL(url).origin === origin;
        const response = await fetchFn(url, {
          method: "GET",
          redirect: "manual",
          headers: sameOrigin ? { Authorization: `Bearer ${config.token}` } : {},
          cache: "no-store",
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) throw new OutlineHttpError(response.status, "attachments.redirect");
          url = new URL(location, url).toString();
          continue;
        }
        if (!response.ok) throw new OutlineHttpError(response.status, "attachments.redirect");
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error("添付ファイルが大きすぎます");
        return { bytes, contentType: response.headers.get("content-type") ?? "" };
      }
      throw new Error("リダイレクトが多すぎます");
    },
  };
}
