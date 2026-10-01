BEGIN;
-- Prepared for a future season. Applying this creates no season or balance.
CREATE SCHEMA mlg_finance;
REVOKE ALL ON SCHEMA mlg_finance FROM PUBLIC,anon,authenticated,service_role;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='mlg_finance_gateway') THEN CREATE ROLE mlg_finance_gateway NOLOGIN; END IF; END $$;
GRANT mlg_finance_gateway TO postgres;
GRANT USAGE ON SCHEMA mlg_finance,mlg_bot TO mlg_finance_gateway;
GRANT SELECT ON mlg_bot.groups,mlg_bot.admins,mlg_bot.users,mlg_bot.wa_identities,mlg_bot.member_blocks,mlg_bot.loan_groups TO mlg_finance_gateway;
GRANT INSERT ON mlg_bot.users,mlg_bot.wa_identities TO mlg_finance_gateway;

CREATE TABLE mlg_finance.seasons (
 id uuid PRIMARY KEY,
 group_id text NOT NULL REFERENCES mlg_bot.groups(id),
 label text NOT NULL CHECK(label ~ '^[a-zA-Z0-9_-]{2,40}$'),
 mode text NOT NULL DEFAULT 'off' CHECK(mode IN ('off','bank','peer','both')),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
 currency text NOT NULL DEFAULT 'MLG' CHECK(currency='MLG'),
 approval text NOT NULL DEFAULT 'manual' CHECK(approval IN ('manual','auto')),
 max_loan bigint NOT NULL DEFAULT 100000 CHECK(max_loan BETWEEN 1 AND 1000000000000),
 max_debt bigint NOT NULL DEFAULT 200000 CHECK(max_debt BETWEEN 1 AND 1000000000000),
 max_days integer NOT NULL DEFAULT 30 CHECK(max_days BETWEEN 1 AND 365),
 max_active integer NOT NULL DEFAULT 1 CHECK(max_active BETWEEN 1 AND 100),
 admin_group text REFERENCES mlg_bot.groups(id),
 emission_alert bigint NOT NULL DEFAULT 100000000000 CHECK(emission_alert BETWEEN 1 AND 1000000000000),
 utilization_alert integer NOT NULL DEFAULT 80 CHECK(utilization_alert BETWEEN 1 AND 100),
 monitored_at bigint NOT NULL DEFAULT 0,
 created_at bigint NOT NULL,
 closed_at bigint,
 UNIQUE(group_id,label),
 CHECK(max_debt>=max_loan),
 CHECK((status='closed')=(closed_at IS NOT NULL))
);
CREATE UNIQUE INDEX finance_one_open ON mlg_finance.seasons(group_id) WHERE status='open';

-- Separate provisional team economy: signed EUR references are NOT loan wallets.
CREATE TABLE mlg_finance.clubs (
 season_id uuid NOT NULL REFERENCES mlg_finance.seasons(id),
 slug text NOT NULL CHECK(slug ~ '^[a-z0-9-]{2,40}$'),
 name text NOT NULL,
 reference_balance bigint NOT NULL CHECK(reference_balance BETWEEN -1000000000000 AND 1000000000000),
 coach_label text NOT NULL,
 owner_id text REFERENCES mlg_bot.users(id),
 transfer_ban boolean NOT NULL DEFAULT false,
 source_date text NOT NULL,
 updated_at bigint NOT NULL,
 PRIMARY KEY(season_id,slug),
 UNIQUE(season_id,owner_id)
);
ALTER TABLE mlg_finance.clubs ENABLE ROW LEVEL SECURITY;
CREATE POLICY finance_backend ON mlg_finance.clubs TO mlg_finance_gateway USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE ON mlg_finance.clubs TO mlg_finance_gateway;

CREATE TABLE mlg_finance.wallets (
 id uuid PRIMARY KEY,
 season_id uuid NOT NULL REFERENCES mlg_finance.seasons(id),
 kind text NOT NULL CHECK(kind IN ('bank','user','issuance')),
 owner_id text REFERENCES mlg_bot.users(id),
 eligible boolean NOT NULL DEFAULT true,
 max_loan bigint CHECK(max_loan BETWEEN 1 AND 1000000000000),
 max_debt bigint CHECK(max_debt BETWEEN 1 AND 1000000000000),
 max_active integer CHECK(max_active BETWEEN 1 AND 100),
 CHECK((kind='user')=(owner_id IS NOT NULL)),
 UNIQUE(season_id,id)
);
CREATE UNIQUE INDEX finance_user_wallet ON mlg_finance.wallets(season_id,owner_id) WHERE kind='user';
CREATE UNIQUE INDEX finance_system_wallet ON mlg_finance.wallets(season_id,kind) WHERE kind<>'user';

CREATE TABLE mlg_finance.loans (
 id text PRIMARY KEY CHECK(id ~ '^F[A-Z0-9]{10}$'),
 season_id uuid NOT NULL REFERENCES mlg_finance.seasons(id),
 model text NOT NULL CHECK(model IN ('bank','peer')),
 lender uuid NOT NULL,
 borrower uuid NOT NULL,
 creator text NOT NULL REFERENCES mlg_bot.users(id),
 principal bigint NOT NULL CHECK(principal BETWEEN 1 AND 1000000000000),
 paid bigint NOT NULL DEFAULT 0 CHECK(paid>=0 AND paid<=principal),
 days integer NOT NULL CHECK(days BETWEEN 1 AND 365),
 status text NOT NULL CHECK(status IN ('pending_approval','pending_acceptance','active','repaid','rejected','cancelled','expired')),
 approval text NOT NULL CHECK(approval IN ('manual','auto','peer')),
 approved_by text REFERENCES mlg_bot.users(id),
 rule_snapshot jsonb NOT NULL,
 created_at bigint NOT NULL,
 expires_at bigint NOT NULL,
 accepted_at bigint,
 due_at bigint,
 FOREIGN KEY(season_id,lender) REFERENCES mlg_finance.wallets(season_id,id),
 FOREIGN KEY(season_id,borrower) REFERENCES mlg_finance.wallets(season_id,id),
 CHECK(lender<>borrower),
 CHECK(expires_at>created_at),
 CHECK((status IN ('active','repaid'))=(accepted_at IS NOT NULL AND due_at IS NOT NULL)),
 CHECK(status<>'repaid' OR paid=principal),
 CHECK(status<>'active' OR paid<principal),
 UNIQUE(season_id,id)
);
CREATE INDEX finance_loans_borrower ON mlg_finance.loans(season_id,borrower,status);
CREATE INDEX finance_loans_lender ON mlg_finance.loans(season_id,lender,status);

-- Each immutable movement debits one account and credits another by the same
-- exact amount: conservation is built into the representation.
CREATE TABLE mlg_finance.journal (
 id uuid PRIMARY KEY,
 season_id uuid NOT NULL REFERENCES mlg_finance.seasons(id),
 source uuid NOT NULL,
 destination uuid NOT NULL,
 amount bigint NOT NULL CHECK(amount BETWEEN 1 AND 1000000000000),
 kind text NOT NULL CHECK(kind IN ('allocation','disbursement','repayment','transfer')),
 loan_id text,
 actor text NOT NULL REFERENCES mlg_bot.users(id),
 message_id text NOT NULL,
 reason text NOT NULL,
 at bigint NOT NULL,
 FOREIGN KEY(season_id,source) REFERENCES mlg_finance.wallets(season_id,id),
 FOREIGN KEY(season_id,destination) REFERENCES mlg_finance.wallets(season_id,id),
 FOREIGN KEY(season_id,loan_id) REFERENCES mlg_finance.loans(season_id,id),
 CHECK(source<>destination),
 CHECK((kind IN ('allocation','transfer'))=(loan_id IS NULL)),
 UNIQUE(season_id,actor,message_id)
);
CREATE UNIQUE INDEX finance_one_disbursement ON mlg_finance.journal(loan_id) WHERE kind='disbursement';
CREATE INDEX finance_journal_source ON mlg_finance.journal(source,at);
CREATE INDEX finance_journal_destination ON mlg_finance.journal(destination,at);

CREATE TABLE mlg_finance.events (
 group_id text NOT NULL REFERENCES mlg_bot.groups(id),
 actor text NOT NULL REFERENCES mlg_bot.users(id),
 message_id text NOT NULL,
 season_id uuid REFERENCES mlg_finance.seasons(id),
 action text NOT NULL,
 result jsonb NOT NULL,
 at bigint NOT NULL,
 PRIMARY KEY(group_id,actor,message_id)
);
CREATE TABLE mlg_finance.outbox (
 id uuid PRIMARY KEY,
 group_id text NOT NULL,
 recipient text,
 actor text NOT NULL,
 message_id text NOT NULL,
 body text NOT NULL CHECK(length(body)<=8000),
 mentions text[] NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 lease uuid,
 lease_until bigint,
 available_at bigint NOT NULL,
 FOREIGN KEY(group_id,actor,message_id) REFERENCES mlg_finance.events(group_id,actor,message_id),
 UNIQUE(group_id,actor,message_id,recipient)
);
CREATE INDEX finance_outbox_pending ON mlg_finance.outbox(available_at) WHERE status IN ('pending','sending');

ALTER TABLE mlg_finance.seasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE mlg_finance.wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE mlg_finance.loans ENABLE ROW LEVEL SECURITY;
ALTER TABLE mlg_finance.journal ENABLE ROW LEVEL SECURITY;
ALTER TABLE mlg_finance.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE mlg_finance.outbox ENABLE ROW LEVEL SECURITY;
-- This role is private and selected only inside the server transaction.
CREATE POLICY finance_backend ON mlg_finance.seasons TO mlg_finance_gateway USING(true) WITH CHECK(true);
CREATE POLICY finance_backend ON mlg_finance.wallets TO mlg_finance_gateway USING(true) WITH CHECK(true);
CREATE POLICY finance_backend ON mlg_finance.loans TO mlg_finance_gateway USING(true) WITH CHECK(true);
CREATE POLICY finance_backend ON mlg_finance.journal TO mlg_finance_gateway USING(true) WITH CHECK(true);
CREATE POLICY finance_backend ON mlg_finance.events TO mlg_finance_gateway USING(true) WITH CHECK(true);
CREATE POLICY finance_backend ON mlg_finance.outbox TO mlg_finance_gateway USING(true) WITH CHECK(true);
REVOKE ALL ON ALL TABLES IN SCHEMA mlg_finance FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE ON mlg_finance.seasons,mlg_finance.wallets,mlg_finance.loans,mlg_finance.outbox TO mlg_finance_gateway;
GRANT SELECT,INSERT ON mlg_finance.journal,mlg_finance.events TO mlg_finance_gateway;
COMMIT;
