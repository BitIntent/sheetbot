-- SheetBot 数据库结构参考（MySQL 8.0+，utf8mb4）
-- 生成日期：2026-06-09
-- 说明：新环境请直接导入本文件初始化库表（mysql < db/schema.sql）
-- ORM 真源：backend/app/**/models.py

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ============================================================
-- 用户认证
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
    id              VARCHAR(36)  NOT NULL PRIMARY KEY,
    username        VARCHAR(50)  NOT NULL,
    email           VARCHAR(255) NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,
    display_name    VARCHAR(100) NULL,
    avatar_url      VARCHAR(500) NULL,
    is_active       TINYINT(1)   NOT NULL DEFAULT 1,
    created_at      DATETIME     NOT NULL,
    updated_at      DATETIME     NOT NULL,
    UNIQUE KEY uq_users_username (username),
    UNIQUE KEY uq_users_email (email),
    KEY idx_users_username (username),
    KEY idx_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id          VARCHAR(36)  NOT NULL PRIMARY KEY,
    user_id     VARCHAR(36)  NOT NULL,
    token_hash  VARCHAR(255) NOT NULL,
    device_info VARCHAR(255) NULL,
    expires_at  DATETIME     NOT NULL,
    revoked_at  DATETIME     NULL,
    created_at  DATETIME     NOT NULL,
    UNIQUE KEY uq_refresh_tokens_token_hash (token_hash),
    KEY idx_user_id (user_id),
    KEY idx_expires (expires_at),
    CONSTRAINT fk_refresh_tokens_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id          VARCHAR(36)  NOT NULL PRIMARY KEY,
    user_id     VARCHAR(36)  NOT NULL,
    token_hash  VARCHAR(128) NOT NULL,
    expires_at  DATETIME     NOT NULL,
    used_at     DATETIME     NULL,
    created_at  DATETIME     NOT NULL,
    UNIQUE KEY uq_password_reset_tokens_token_hash (token_hash),
    KEY ix_password_reset_tokens_user_id (user_id),
    KEY ix_password_reset_tokens_token_hash (token_hash),
    CONSTRAINT fk_password_reset_tokens_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- 文件管理
-- ============================================================

CREATE TABLE IF NOT EXISTS folders (
    id         VARCHAR(36)  NOT NULL PRIMARY KEY,
    user_id    VARCHAR(36)  NOT NULL,
    name       VARCHAR(255) NOT NULL,
    parent_id  VARCHAR(36)  NULL,
    created_at DATETIME     NOT NULL,
    updated_at DATETIME     NOT NULL,
    KEY idx_folder_user (user_id),
    KEY idx_folder_parent (parent_id),
    CONSTRAINT fk_folders_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_folders_parent_id FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_files (
    id              VARCHAR(36)  NOT NULL PRIMARY KEY,
    user_id         VARCHAR(36)  NOT NULL,
    file_name       VARCHAR(255) NOT NULL,
    file_type       VARCHAR(20)  NOT NULL DEFAULT 'upload',
    file_format     VARCHAR(10)  DEFAULT 'xlsx',
    file_size       BIGINT       DEFAULT 0,
    storage_path    VARCHAR(500) NOT NULL,
    folder_id       VARCHAR(36)  NULL,
    is_starred      TINYINT(1)   DEFAULT 0,
    source_file_id  VARCHAR(36)  NULL,
    last_view       VARCHAR(20)  DEFAULT 'normal',
    sheet_names     VARCHAR(2000) NULL,
    row_count       INT          DEFAULT 0,
    col_count       INT          DEFAULT 0,
    duckdb_ready    TINYINT(1)   DEFAULT 0,
    status          VARCHAR(20)  DEFAULT 'active',
    created_at      DATETIME     NOT NULL,
    updated_at      DATETIME     NOT NULL,
    accessed_at     DATETIME     NOT NULL,
    KEY idx_user_status (user_id, status),
    KEY idx_folder (folder_id),
    KEY idx_source (source_file_id),
    KEY idx_starred (user_id, is_starred),
    CONSTRAINT fk_user_files_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_user_files_folder_id FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE SET NULL,
    CONSTRAINT fk_user_files_source_file_id FOREIGN KEY (source_file_id) REFERENCES user_files(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_sessions (
    id               VARCHAR(36)  NOT NULL PRIMARY KEY,
    user_id          VARCHAR(36)  NOT NULL,
    session_id       VARCHAR(100) NOT NULL,
    platform_view    VARCHAR(20)  DEFAULT 'normal',
    current_file_id  VARCHAR(36)  NULL,
    last_active_at   DATETIME     NOT NULL,
    session_metadata VARCHAR(2000) NULL,
    UNIQUE KEY uq_user_sessions_session_id (session_id),
    KEY idx_user_id (user_id),
    KEY idx_session (session_id),
    CONSTRAINT fk_user_sessions_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_user_sessions_current_file_id FOREIGN KEY (current_file_id) REFERENCES user_files(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- 报表
-- ============================================================

CREATE TABLE IF NOT EXISTS report_cache (
    id            VARCHAR(36)  NOT NULL PRIMARY KEY,
    user_id       VARCHAR(36)  NOT NULL,
    file_id       VARCHAR(36)  NOT NULL,
    template_key  VARCHAR(50)  NOT NULL,
    options_hash  VARCHAR(1000) NOT NULL DEFAULT '',
    snapshot_path VARCHAR(500) NOT NULL,
    status        VARCHAR(20)  DEFAULT 'active',
    expires_at    DATETIME     NOT NULL,
    created_at    DATETIME     NOT NULL,
    updated_at    DATETIME     NOT NULL,
    KEY idx_cache_user (user_id),
    KEY idx_cache_file_template (file_id, template_key, options_hash),
    KEY idx_cache_status (status),
    KEY idx_cache_expires (expires_at),
    CONSTRAINT fk_report_cache_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_report_cache_file_id FOREIGN KEY (file_id) REFERENCES user_files(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS shared_reports (
    id                   VARCHAR(36)  NOT NULL PRIMARY KEY,
    user_id              VARCHAR(36)  NOT NULL,
    source_file_id       VARCHAR(36)  NULL,
    report_cache_id      VARCHAR(36)  NULL,
    share_token          VARCHAR(64)  NOT NULL,
    title                VARCHAR(500) NOT NULL DEFAULT '数据报表',
    template_key         VARCHAR(50)  NOT NULL DEFAULT 'overview',
    report_snapshot_path VARCHAR(500) NOT NULL,
    is_public            TINYINT(1)   DEFAULT 1,
    view_count           INT          DEFAULT 0,
    status               VARCHAR(20)  DEFAULT 'active',
    created_at           DATETIME     NOT NULL,
    updated_at           DATETIME     NOT NULL,
    expires_at           DATETIME     NULL,
    UNIQUE KEY uq_shared_reports_share_token (share_token),
    KEY idx_report_user (user_id),
    KEY idx_report_token (share_token),
    KEY idx_report_status (status),
    KEY idx_report_cache (report_cache_id),
    CONSTRAINT fk_shared_reports_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_shared_reports_source_file_id FOREIGN KEY (source_file_id) REFERENCES user_files(id) ON DELETE SET NULL,
    CONSTRAINT fk_shared_report_cache_id FOREIGN KEY (report_cache_id) REFERENCES report_cache(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS report_tasks (
    id               VARCHAR(36)  NOT NULL PRIMARY KEY,
    user_id          VARCHAR(36)  NOT NULL,
    file_id          VARCHAR(36)  NOT NULL,
    template_key     VARCHAR(50)  NOT NULL,
    options_json     TEXT         NULL,
    status           VARCHAR(20)  DEFAULT 'pending',
    progress         INT          DEFAULT 0,
    progress_message VARCHAR(255) NULL,
    report_cache_id  VARCHAR(36)  NULL,
    error_message    TEXT         NULL,
    created_at       DATETIME     NOT NULL,
    updated_at       DATETIME     NOT NULL,
    completed_at     DATETIME     NULL,
    KEY idx_task_user_status (user_id, status),
    CONSTRAINT fk_report_tasks_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- PPTX / 批量 Word
-- ============================================================

CREATE TABLE IF NOT EXISTS user_pptx (
    pptx_id          VARCHAR(64)  NOT NULL PRIMARY KEY,
    user_id          VARCHAR(36)  NOT NULL,
    title            VARCHAR(500) NOT NULL DEFAULT '',
    template_key     VARCHAR(100) NOT NULL DEFAULT '',
    source_file_id   VARCHAR(36)  NULL,
    meta_rel_path    VARCHAR(512) NOT NULL,
    pptx_rel_path    VARCHAR(512) NOT NULL,
    slide_count      INT          NOT NULL DEFAULT 0,
    pptx_size_bytes  BIGINT       NOT NULL DEFAULT 0,
    status           VARCHAR(20)  NOT NULL DEFAULT 'active',
    created_at       DATETIME     NOT NULL,
    updated_at       DATETIME     NOT NULL,
    KEY idx_user_pptx_user (user_id),
    KEY idx_user_pptx_status (status),
    KEY idx_user_pptx_created (created_at),
    CONSTRAINT fk_user_pptx_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS batch_word_exports (
    task_id              VARCHAR(64)  NOT NULL PRIMARY KEY,
    user_id              VARCHAR(36)  NOT NULL,
    template_id          VARCHAR(64)  NULL,
    template_file_name   VARCHAR(500) NOT NULL DEFAULT '',
    source_file_id       VARCHAR(36)  NULL,
    filename_pattern     VARCHAR(500) NULL,
    zip_rel_path         VARCHAR(512) NOT NULL,
    total                INT          NOT NULL DEFAULT 0,
    zip_size_bytes       BIGINT       NOT NULL DEFAULT 0,
    status               VARCHAR(20)  NOT NULL DEFAULT 'active',
    created_at           DATETIME     NOT NULL,
    updated_at           DATETIME     NOT NULL,
    KEY idx_bwe_user (user_id),
    KEY idx_bwe_status (status),
    KEY idx_bwe_created (created_at),
    CONSTRAINT fk_batch_word_exports_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- 通知 / 配置
-- ============================================================

CREATE TABLE IF NOT EXISTS notifications (
    id         VARCHAR(36)  NOT NULL PRIMARY KEY,
    user_id    VARCHAR(36)  NOT NULL,
    type       VARCHAR(50)  NOT NULL,
    title      VARCHAR(255) NOT NULL,
    message    TEXT         NULL,
    is_read    TINYINT(1)   DEFAULT 0,
    payload    TEXT         NULL,
    created_at DATETIME     NOT NULL,
    KEY idx_notification_user (user_id),
    CONSTRAINT fk_notifications_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_preferences (
    id                 VARCHAR(36) NOT NULL PRIMARY KEY,
    user_id            VARCHAR(36) NOT NULL,
    timezone           VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai',
    language           VARCHAR(10) NOT NULL DEFAULT 'zh-CN',
    notification_prefs TEXT        NULL,
    created_at         DATETIME    NOT NULL,
    updated_at         DATETIME    NOT NULL,
    UNIQUE KEY uq_user_preferences_user_id (user_id),
    CONSTRAINT fk_user_preferences_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS platform_settings (
    config_key   VARCHAR(64)  NOT NULL PRIMARY KEY,
    config_value VARCHAR(512) NOT NULL,
    updated_at   DATETIME     NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- 自定义公式 / 技能库
-- ============================================================

CREATE TABLE IF NOT EXISTS custom_formulas (
    id          VARCHAR(36)  NOT NULL PRIMARY KEY,
    user_id     VARCHAR(36)  NOT NULL,
    name        VARCHAR(100) NOT NULL,
    description VARCHAR(500) NULL,
    expression  TEXT         NOT NULL,
    params_json TEXT         NULL,
    created_at  DATETIME     NOT NULL,
    updated_at  DATETIME     NOT NULL,
    UNIQUE KEY uq_custom_formulas_user_name (user_id, name),
    CONSTRAINT fk_custom_formulas_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS skills (
    id          VARCHAR(36)  NOT NULL PRIMARY KEY,
    user_id     VARCHAR(36)  NOT NULL,
    name        VARCHAR(200) NOT NULL,
    description TEXT         NULL,
    scope_json  TEXT         NULL,
    steps_json  TEXT         NOT NULL,
    tags_json   TEXT         NULL,
    is_preset   TINYINT(1)   DEFAULT 0,
    created_at  DATETIME     NOT NULL,
    updated_at  DATETIME     NOT NULL,
    CONSTRAINT fk_skills_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- 表单收集 / 连接器
-- ============================================================

CREATE TABLE IF NOT EXISTS forms (
    id                VARCHAR(36)  NOT NULL PRIMARY KEY,
    user_id           VARCHAR(36)  NOT NULL,
    file_id           VARCHAR(36)  NULL,
    sheet_name        VARCHAR(255) NULL,
    title             VARCHAR(500) NOT NULL DEFAULT '',
    description       TEXT         NULL,
    share_token       VARCHAR(64)  NOT NULL,
    form_config       TEXT         NOT NULL DEFAULT '{}',
    status            VARCHAR(20)  NOT NULL DEFAULT 'draft',
    max_submissions   INT          NULL,
    expires_at        DATETIME     NULL,
    submission_count  INT          NOT NULL DEFAULT 0,
    created_at        DATETIME     NOT NULL,
    updated_at        DATETIME     NOT NULL,
    UNIQUE KEY uq_forms_share_token (share_token),
    KEY ix_forms_share_token (share_token),
    CONSTRAINT fk_forms_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_forms_file_id FOREIGN KEY (file_id) REFERENCES user_files(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS form_submissions (
    id           VARCHAR(36) NOT NULL PRIMARY KEY,
    form_id      VARCHAR(36) NOT NULL,
    data         TEXT        NOT NULL DEFAULT '{}',
    ip_address   VARCHAR(64) NULL,
    user_agent   VARCHAR(500) NULL,
    synced       TINYINT(1)  NOT NULL DEFAULT 0,
    submitted_at DATETIME    NOT NULL,
    KEY ix_form_submissions_form_id (form_id),
    CONSTRAINT fk_form_submissions_form_id FOREIGN KEY (form_id) REFERENCES forms(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS connectors (
    id                VARCHAR(36)  NOT NULL PRIMARY KEY,
    user_id           VARCHAR(36)  NOT NULL,
    file_id           VARCHAR(36)  NULL,
    sheet_name        VARCHAR(255) NULL,
    name              VARCHAR(500) NOT NULL DEFAULT '',
    type              VARCHAR(30)  NOT NULL,
    config            TEXT         NOT NULL DEFAULT '{}',
    field_mapping     TEXT         NOT NULL DEFAULT '{}',
    sync_interval     INT          NOT NULL DEFAULT 0,
    status            VARCHAR(20)  NOT NULL DEFAULT 'paused',
    last_sync_at      DATETIME     NULL,
    last_sync_status  VARCHAR(20)  NULL,
    last_sync_message TEXT         NULL,
    created_at        DATETIME     NOT NULL,
    updated_at        DATETIME     NOT NULL,
    KEY ix_connectors_user_id (user_id),
    CONSTRAINT fk_connectors_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_connectors_file_id FOREIGN KEY (file_id) REFERENCES user_files(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sync_jobs (
    id            VARCHAR(36) NOT NULL PRIMARY KEY,
    connector_id  VARCHAR(36) NOT NULL,
    status        VARCHAR(20) NOT NULL DEFAULT 'running',
    rows_synced   INT         NOT NULL DEFAULT 0,
    error_message TEXT        NULL,
    started_at    DATETIME    NOT NULL,
    completed_at  DATETIME    NULL,
    KEY ix_sync_jobs_connector_id (connector_id),
    CONSTRAINT fk_sync_jobs_connector_id FOREIGN KEY (connector_id) REFERENCES connectors(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- 商务咨询
-- ============================================================

CREATE TABLE IF NOT EXISTS business_inquiries (
    id           VARCHAR(36)  NOT NULL PRIMARY KEY,
    product      VARCHAR(32)  NOT NULL DEFAULT 'sheetbot',
    company_name VARCHAR(255) NOT NULL DEFAULT '',
    contact_name VARCHAR(100) NOT NULL DEFAULT '',
    phone        VARCHAR(64)  NOT NULL DEFAULT '',
    email        VARCHAR(255) NULL,
    message      TEXT         NOT NULL DEFAULT '',
    source_page  VARCHAR(128) NOT NULL DEFAULT 'site_contact',
    status       VARCHAR(20)  NOT NULL DEFAULT 'pending',
    admin_note   TEXT         NULL,
    ip_address   VARCHAR(64)  NULL,
    user_agent   VARCHAR(500) NULL,
    created_at   DATETIME     NOT NULL,
    updated_at   DATETIME     NOT NULL,
    KEY ix_business_inquiries_product (product),
    KEY ix_business_inquiries_status (status),
    KEY ix_business_inquiries_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- 套餐 / 订阅 / 用量
-- ============================================================

CREATE TABLE IF NOT EXISTS subscription_plans (
    id             VARCHAR(36)  NOT NULL PRIMARY KEY,
    code           VARCHAR(30)  NOT NULL,
    name           VARCHAR(100) NOT NULL,
    price_monthly  INT          NOT NULL DEFAULT 0,
    price_yearly   INT          NOT NULL DEFAULT 0,
    quota_json     TEXT         NOT NULL DEFAULT '{}',
    is_active      TINYINT(1)   NOT NULL DEFAULT 1,
    sort_order     INT          NOT NULL DEFAULT 0,
    created_at     DATETIME     NOT NULL,
    updated_at     DATETIME     NOT NULL,
    UNIQUE KEY uq_subscription_plans_code (code),
    KEY ix_subscription_plans_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_subscriptions (
    id         VARCHAR(36) NOT NULL PRIMARY KEY,
    user_id    VARCHAR(36) NOT NULL,
    plan_code  VARCHAR(30) NOT NULL DEFAULT 'free',
    status     VARCHAR(20) NOT NULL DEFAULT 'active',
    started_at DATETIME    NOT NULL,
    expires_at DATETIME    NULL,
    granted_by VARCHAR(36) NULL,
    notes      VARCHAR(500) NULL,
    created_at DATETIME    NOT NULL,
    updated_at DATETIME    NOT NULL,
    UNIQUE KEY uq_user_subscriptions_user_id (user_id),
    KEY ix_user_subscriptions_user_id (user_id),
    CONSTRAINT fk_user_subscriptions_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_user_subscriptions_plan_code FOREIGN KEY (plan_code) REFERENCES subscription_plans(code) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS usage_records (
    id                VARCHAR(36) NOT NULL PRIMARY KEY,
    user_id           VARCHAR(36) NOT NULL,
    record_date       VARCHAR(10) NOT NULL,
    ai_count          INT         NOT NULL DEFAULT 0,
    report_count      INT         NOT NULL DEFAULT 0,
    ppt_count         INT         NOT NULL DEFAULT 0,
    batch_word_count  INT         NOT NULL DEFAULT 0,
    large_file_count  INT         NOT NULL DEFAULT 0,
    form_submit_count INT         NOT NULL DEFAULT 0,
    storage_mb_used   INT         NOT NULL DEFAULT 0,
    created_at        DATETIME    NOT NULL,
    KEY ix_usage_records_user_id (user_id),
    KEY ix_usage_records_record_date (record_date),
    CONSTRAINT fk_usage_records_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS system_announcements (
    id         VARCHAR(36)  NOT NULL PRIMARY KEY,
    title      VARCHAR(255) NOT NULL,
    content    TEXT         NOT NULL,
    type       VARCHAR(20)  NOT NULL DEFAULT 'info',
    target     VARCHAR(100) NOT NULL DEFAULT 'all',
    is_active  TINYINT(1)   NOT NULL DEFAULT 1,
    publish_at DATETIME     NOT NULL,
    expire_at  DATETIME     NULL,
    created_at DATETIME     NOT NULL,
    updated_at DATETIME     NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET FOREIGN_KEY_CHECKS = 1;
