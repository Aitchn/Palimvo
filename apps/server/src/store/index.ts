import path from "node:path";
import { AccountsRepo, type VaultMember, type VaultPosition } from "./accounts.ts";
import { AuditRepo } from "./audit.ts";
import { Db, DB_FILE, type BackupResult } from "./db.ts";
import { InvitesRepo } from "./invites.ts";
import { LibraryRepo } from "./library.ts";
import { MIGRATIONS } from "./migrations.ts";
import { OAuthRepo } from "./oauth.ts";
import { PluginsRepo } from "./plugins.ts";
import { PublicAccessRepo } from "./publicAccess.ts";
import { RolesRepo, type Role } from "./roles.ts";
import { SessionsRepo } from "./sessions.ts";
import { SettingsRepo } from "./settings.ts";
import { TokensRepo } from "./tokens.ts";

export { DB_FILE, isUniqueViolation, type BackupResult } from "./db.ts";
export * from "./accounts.ts";
export * from "./audit.ts";
export * from "./invites.ts";
export * from "./library.ts";
export * from "./plugins.ts";
export * from "./publicAccess.ts";
export * from "./oauth.ts";
export * from "./roles.ts";
export * from "./sessions.ts";
export * from "./settings.ts";
export * from "./tokens.ts";

export interface StoreOptions {
  /** `:memory:` keeps everything in RAM (unit tests). */
  file: string;
  /** Clock override for tests. */
  now?: () => number;
  checkpointIntervalMs?: number;
}

/** Server-level metadata: accounts, sessions, roles, tokens, OAuth, audit log, settings. */
export class Store {
  readonly accounts: AccountsRepo;
  readonly sessions: SessionsRepo;
  readonly roles: RolesRepo;
  readonly tokens: TokensRepo;
  readonly oauth: OAuthRepo;
  readonly audit: AuditRepo;
  readonly settings: SettingsRepo;
  readonly library: LibraryRepo;
  readonly invites: InvitesRepo;
  readonly publicAccess: PublicAccessRepo;
  readonly plugins: PluginsRepo;

  private constructor(
    private readonly db: Db,
    now: () => number,
  ) {
    this.accounts = new AccountsRepo(db, now);
    this.sessions = new SessionsRepo(db, now);
    this.roles = new RolesRepo(db, now);
    this.tokens = new TokensRepo(db, now);
    this.oauth = new OAuthRepo(db, now);
    this.audit = new AuditRepo(db, now);
    this.settings = new SettingsRepo(db, now);
    this.library = new LibraryRepo(db, now);
    this.invites = new InvitesRepo(db, now);
    this.publicAccess = new PublicAccessRepo(db, now);
    this.plugins = new PluginsRepo(db, now);
  }

  static async open(options: StoreOptions): Promise<Store> {
    const db = await Db.open(options.file, {
      migrations: MIGRATIONS,
      ...(options.checkpointIntervalMs === undefined
        ? {}
        : { checkpointIntervalMs: options.checkpointIntervalMs }),
    });
    return new Store(db, options.now ?? (() => Date.now()));
  }

  /** Opens `palimvo.db` inside the server's data directory. */
  static openInDataDir(dataDir: string, options: Omit<StoreOptions, "file"> = {}): Promise<Store> {
    return Store.open({ ...options, file: path.join(dataDir, DB_FILE) });
  }

  /**
   * Adds a person to a vault (or changes their position) and gives the vault the join defaults of
   * every role they hold, such as the Reader deny. Use this instead of `accounts.setMember`.
   */
  joinVault(vaultId: string, accountId: string, position: VaultPosition): VaultMember {
    return this.db.tx(() => {
      const member = this.accounts.setMember(vaultId, accountId, position);
      for (const role of this.rolesWithEveryone(accountId)) this.applyJoinDefaults(role, vaultId);
      return member;
    });
  }

  /** Gives a role to a person and the vaults they already belong to its join defaults. */
  grantRole(roleId: string, accountId: string): void {
    this.db.tx(() => {
      this.roles.assign(roleId, accountId);
      const role = this.roles.require(roleId);
      for (const m of this.accounts.listMemberships(accountId))
        this.applyJoinDefaults(role, m.vaultId);
    });
  }

  private rolesWithEveryone(accountId: string): Role[] {
    const everyone = this.roles.getEveryone();
    return [...(everyone ? [everyone] : []), ...this.roles.rolesOf(accountId)];
  }

  /** Writes the role's join deny into the vault the first time; later edits by admins stay. */
  private applyJoinDefaults(role: Role, vaultId: string): void {
    if (role.joinDeny === 0) return;
    const target = {
      scope: "vault",
      vaultId,
      subjectType: "role",
      subjectId: role.id,
    } as const;
    if (this.roles.getOverride(target)) return;
    this.roles.setOverride(target, { allow: 0, deny: role.joinDeny });
  }

  /** Runs `fn` in one write transaction; see `Db.tx`. Use it to change several repositories atomically. */
  tx<T>(fn: () => T): T {
    return this.db.tx(fn);
  }

  get schemaVersion(): number {
    return this.db.userVersion;
  }

  /** `PRAGMA integrity_check` problems; empty when the database is sound. */
  integrityProblems(): string[] {
    return this.db.integrityProblems();
  }

  /** Online, verified copy of the database (used by `palimvo backup`). */
  backup(dest: string): Promise<BackupResult> {
    return this.db.backup(dest);
  }

  checkpoint(): void {
    this.db.checkpoint();
  }

  close(): void {
    this.db.close();
  }
}
