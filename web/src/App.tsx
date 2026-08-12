import { useMemo, useState } from "react";

type Scope = "all" | "shared" | "mine";

interface Transaction {
  id: string;
  title: string;
  amount: number;
  category: string;
  meal?: string;
  time: string;
  scope: "shared" | "mine" | "partner";
  icon: string;
  tone: "lime" | "coral" | "sky" | "lilac";
}

const initialTransactions: Transaction[] = [
  { id: "K7M2Q9TX", title: "牛肉麵", amount: 150, category: "食物", meal: "午餐", time: "今天 12:10", scope: "shared", icon: "麵", tone: "coral" },
  { id: "F2R8W6NP", title: "週末電影", amount: 640, category: "娛樂", time: "昨天 20:30", scope: "shared", icon: "影", tone: "lilac" },
  { id: "C9H3M7DK", title: "咖啡", amount: 95, category: "食物", time: "昨天 15:42", scope: "mine", icon: "啡", tone: "lime" },
  { id: "T4V8B2QS", title: "捷運加值", amount: 500, category: "交通", time: "8/10 08:05", scope: "partner", icon: "行", tone: "sky" },
];

const formatMoney = (value: number) => new Intl.NumberFormat("zh-TW").format(value);

export function App() {
  const [scope, setScope] = useState<Scope>("all");
  const [transactions, setTransactions] = useState(initialTransactions);
  const [composerOpen, setComposerOpen] = useState(false);
  const [quickText, setQuickText] = useState("");
  const [toast, setToast] = useState<string | null>(null);

  const filtered = useMemo(
    () => transactions.filter((item) => scope === "all" || item.scope === scope || (scope === "shared" && item.scope === "shared")),
    [scope, transactions],
  );
  const total = transactions.reduce((sum, item) => sum + item.amount, 0);
  const shared = transactions.filter((item) => item.scope === "shared").reduce((sum, item) => sum + item.amount, 0);
  const mine = transactions.filter((item) => item.scope === "mine").reduce((sum, item) => sum + item.amount, 0);

  function addExpense() {
    const match = /^(.*\D)\s*(\d+)$/u.exec(quickText.trim());
    if (!match) {
      setToast("輸入項目和金額，例如：早餐 85");
      return;
    }
    const newItem: Transaction = {
      id: Math.random().toString(36).slice(2, 10).toUpperCase(),
      title: match[1]!.trim(),
      amount: Number(match[2]),
      category: "待分類",
      time: "剛剛",
      scope: "shared",
      icon: "新",
      tone: "lime",
    };
    setTransactions((items) => [newItem, ...items]);
    setQuickText("");
    setComposerOpen(false);
    setToast(`已加入「${newItem.title}」`);
    window.setTimeout(() => setToast(null), 2600);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Dinero 首頁">
          <span className="brand-mark"><i /><i /></span>
          <span>dinero</span>
        </a>
        <button className="pair-pill" type="button" aria-label="查看成員">
          <span className="avatar avatar-lin">L</span>
          <span className="avatar avatar-kev">K</span>
          <span className="live-dot" />
        </button>
      </header>

      <main id="top">
        <section className="hero">
          <div className="hero-heading">
            <div>
              <p className="eyebrow">2026 年 8 月</p>
              <h1>日子一起過，<br />帳也一起記。</h1>
            </div>
            <button className="month-button" type="button" aria-label="切換月份">
              <CalendarIcon />
            </button>
          </div>

          <article className="balance-card">
            <div className="balance-topline">
              <span>本月總支出</span>
              <span className="sync-status"><i /> 已同步 LINE</span>
            </div>
            <div className="balance-amount"><small>NT$</small>{formatMoney(total)}</div>
            <div className="balance-rule" />
            <div className="balance-splits">
              <div><span>共同</span><strong>{formatMoney(shared)}</strong></div>
              <div><span>我的個人</span><strong>{formatMoney(mine)}</strong></div>
              <div><span>另一半</span><strong>{formatMoney(total - shared - mine)}</strong></div>
            </div>
            <span className="card-orbit orbit-one" />
            <span className="card-orbit orbit-two" />
          </article>
        </section>

        <section className="content-section">
          <div className="section-title-row">
            <div>
              <p className="eyebrow">OVERVIEW</p>
              <h2>錢都花去哪了</h2>
            </div>
            <button className="text-button" type="button">看分析 <ArrowIcon /></button>
          </div>
          <div className="category-strip">
            <CategoryCard icon="食" name="食物" amount="4,280" percent={68} tone="coral" />
            <CategoryCard icon="行" name="交通" amount="2,310" percent={42} tone="sky" />
            <CategoryCard icon="樂" name="娛樂" amount="2,000" percent={36} tone="lilac" />
          </div>
        </section>

        <section className="content-section transactions-section">
          <div className="section-title-row recent-title">
            <div>
              <p className="eyebrow">RECENT</p>
              <h2>最近幾筆</h2>
            </div>
            <button className="icon-button" type="button" aria-label="搜尋"><SearchIcon /></button>
          </div>

          <div className="scope-tabs" role="tablist" aria-label="支出範圍">
            {([['all', '全部'], ['shared', '共同'], ['mine', '我的']] as const).map(([value, label]) => (
              <button key={value} className={scope === value ? "active" : ""} onClick={() => setScope(value)} role="tab" aria-selected={scope === value}>{label}</button>
            ))}
          </div>

          <div className="transaction-list">
            {filtered.map((item) => (
              <button className="transaction-row" key={item.id} type="button">
                <span className={`transaction-icon ${item.tone}`}>{item.icon}</span>
                <span className="transaction-copy">
                  <strong>{item.title}</strong>
                  <small>{item.time} · #{item.id}</small>
                </span>
                <span className="transaction-meta">
                  <strong>− {formatMoney(item.amount)}</strong>
                  <small>{item.category}{item.meal ? ` · ${item.meal}` : ""}</small>
                </span>
              </button>
            ))}
          </div>
        </section>
      </main>

      <nav className="bottom-nav" aria-label="主要選單">
        <button className="active" type="button"><HomeIcon /><span>首頁</span></button>
        <button type="button"><ChartIcon /><span>分析</span></button>
        <button className="add-button" type="button" onClick={() => setComposerOpen(true)} aria-label="新增支出"><PlusIcon /></button>
        <button type="button"><ListIcon /><span>帳目</span></button>
        <button type="button"><UserIcon /><span>我的</span></button>
      </nav>

      {composerOpen && (
        <div className="sheet-backdrop" role="presentation" onMouseDown={() => setComposerOpen(false)}>
          <section className="composer-sheet" role="dialog" aria-modal="true" aria-labelledby="composer-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="sheet-handle" />
            <p className="eyebrow">QUICK ADD</p>
            <h2 id="composer-title">這筆花了什麼？</h2>
            <p className="sheet-hint">像在 LINE 裡一樣輸入，分類和餐別交給 Dinero。</p>
            <div className="quick-input-wrap">
              <input autoFocus value={quickText} onChange={(event) => setQuickText(event.target.value)} onKeyDown={(event) => event.key === "Enter" && addExpense()} placeholder="牛肉麵 150 #約會" aria-label="支出內容" />
              <button type="button" onClick={addExpense}><ArrowUpIcon /></button>
            </div>
            <div className="composer-options">
              <button type="button" className="selected">共同</button>
              <button type="button">個人</button>
              <button type="button"><CalendarIcon /> 今天</button>
            </div>
          </section>
        </div>
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function CategoryCard({ icon, name, amount, percent, tone }: { icon: string; name: string; amount: string; percent: number; tone: string }) {
  return (
    <article className="category-card">
      <span className={`category-icon ${tone}`}>{icon}</span>
      <div><strong>{name}</strong><small>NT$ {amount}</small></div>
      <span className="progress"><i style={{ width: `${percent}%` }} /></span>
    </article>
  );
}

const Svg = ({ children, viewBox = "0 0 24 24" }: { children: React.ReactNode; viewBox?: string }) => <svg viewBox={viewBox} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
const CalendarIcon = () => <Svg><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M8 3v4M16 3v4M3 10h18" /></Svg>;
const ArrowIcon = () => <Svg><path d="m9 18 6-6-6-6" /></Svg>;
const SearchIcon = () => <Svg><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></Svg>;
const HomeIcon = () => <Svg><path d="m3 11 9-8 9 8v9a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z" /></Svg>;
const ChartIcon = () => <Svg><path d="M4 20V10M10 20V4M16 20v-7M22 20V7" /></Svg>;
const PlusIcon = () => <Svg><path d="M12 5v14M5 12h14" /></Svg>;
const ListIcon = () => <Svg><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" /></Svg>;
const UserIcon = () => <Svg><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></Svg>;
const ArrowUpIcon = () => <Svg><path d="m12 19V5M6 11l6-6 6 6" /></Svg>;
