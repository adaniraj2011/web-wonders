"use client";

import { useEffect, useMemo, useState } from "react";
import { format, parseISO, isSameDay, isWithinInterval, addDays, startOfMonth, endOfMonth, parse } from "date-fns";

// ---- localStorage hook ----
function useStoredState(key, initialValue) {
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(key);
    if (stored) {
      try {
        setValue(JSON.parse(stored));
      } catch (e) {
        console.error("Failed to parse stored value", e);
      }
    }
  }, [key]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);

  return [value, setValue];
}

// ---- data shapes ----
const emptyData = {
  clients: [],
  planner: [], // {id, clientId, date, platform, type, title, caption, status}
  efforts: [], // {id, clientId, date, posts, reels, minutes, notes}
  tasks: [], // {id, title, description, clientId, assignee, status, priority, dueDate}
  invoices: [], // {id, clientId, month, amount, dueDate, status}
  paymentsOut: [], // reserved for future
  projections: [] // {id, startDate, endDate, type, revenueTarget, clientTarget, note}
};

const STATUS_COLORS = {
  planned: "status-planned",
  done: "status-done",
  overdue: "status-overdue",
  skipped: "status-overdue",
  pending: "status-pending",
  paid: "status-paid"
};

// Generate simple IDs
const nextId = () => Math.floor(Math.random() * 1_000_000_000);

// ---- main page ----
export default function HomePage() {
  const [data, setData] = useStoredState("webwonders-data-v1", emptyData);
  const [tab, setTab] = useState("dashboard");

  const [today] = useState(() => new Date());

  // derived: clients map
  const clientsMap = useMemo(() => {
    const m = new Map();
    data.clients.forEach((c) => m.set(c.id, c));
    return m;
  }, [data.clients]);

  // --- dashboard derived sections ---
  const dashboardSections = useMemo(() => {
    const todayItems = [];
    const weekItems = [];
    const overdueItems = [];
    const startWeek = addDays(today, -3);
    const endWeek = addDays(today, 3);

    data.planner.forEach((item) => {
      const d = parseISO(item.date);
      if (isSameDay(d, today)) todayItems.push(item);
      if (isWithinInterval(d, { start: startWeek, end: endWeek })) weekItems.push(item);
      if (item.status === "overdue") overdueItems.push(item);
      if (item.status !== "done" && d < today && item.status !== "skipped") {
        // auto mark overdue
        overdueItems.push(item);
      }
    });

    // effort summary last 30 days
    const fromDate = addDays(today, -30);
    const effortByClient = new Map();

    data.efforts.forEach((e) => {
      const d = parseISO(e.date);
      if (!isWithinInterval(d, { start: fromDate, end: today })) return;
      const prev = effortByClient.get(e.clientId) || 0;
      effortByClient.set(e.clientId, prev + (e.minutes || 0));
    });

    const rows = [];
    let total = 0;
    for (const [clientId, minutes] of effortByClient.entries()) {
      total += minutes;
      rows.push({
        clientId,
        minutes,
        name: clientsMap.get(clientId)?.name || "Unknown"
      });
    }
    rows.sort((a, b) => b.minutes - a.minutes);
    const summary = rows.map((r) => ({
      ...r,
      pct: total ? Math.round((r.minutes / total) * 10) / 10 * 100 / 100 : 0
    }));
    const top = summary[0] || null;

    // projection
    const nowStr = format(today, "yyyy-MM-dd");
    const activeProjection = data.projections.find(
      (p) => p.startDate <= nowStr && p.endDate >= nowStr
    );

    let projectionProgress = null;
    if (activeProjection) {
      // revenue = paid invoices in range
      let achievedRevenue = 0;
      const clientSet = new Set();
      data.invoices.forEach((inv) => {
        if (inv.status !== "paid") return;
        if (inv.dueDate < activeProjection.startDate || inv.dueDate > activeProjection.endDate) return;
        achievedRevenue += Number(inv.amount || 0);
        clientSet.add(inv.clientId);
      });

      const achievedClients = clientSet.size;
      const revenuePct = activeProjection.revenueTarget
        ? (achievedRevenue / activeProjection.revenueTarget) * 100
        : 0;
      const clientPct = activeProjection.clientTarget
        ? (achievedClients / activeProjection.clientTarget) * 100
        : 0;

      projectionProgress = {
        achievedRevenue,
        achievedClients,
        revenuePct: Math.round(revenuePct * 10) / 10,
        clientPct: Math.round(clientPct * 10) / 10
      };
    }

    // overdue invoices
    const overdueInvoices = data.invoices.filter(
      (inv) => inv.status === "overdue" || (inv.status !== "paid" && inv.dueDate < format(today, "yyyy-MM-dd"))
    );

    return { todayItems, weekItems, overdueItems, summary, top, activeProjection, projectionProgress, overdueInvoices };
  }, [data, today, clientsMap]);

  // helper to update overdue statuses on planner + invoices
  const normalizeOverdues = () => {
    const todayStr = format(today, "yyyy-MM-dd");
    const updatedPlanner = data.planner.map((it) => {
      if (it.status === "done" || it.status === "skipped") return it;
      if (it.date < todayStr) {
        return { ...it, status: "overdue" };
      }
      return it;
    });
    const updatedInvoices = data.invoices.map((inv) => {
      if (inv.status === "paid") return inv;
      if (inv.dueDate < todayStr) return { ...inv, status: "overdue" };
      return inv;
    });
    setData({ ...data, planner: updatedPlanner, invoices: updatedInvoices });
  };

  useEffect(() => {
    normalizeOverdues();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once on load

  // generic handlers
  const upsertPlannerItem = (item) => {
    setData((prev) => {
      const existing = prev.planner.find((p) => p.id === item.id);
      if (existing) {
        return {
          ...prev,
          planner: prev.planner.map((p) => (p.id === item.id ? item : p))
        };
      }
      return {
        ...prev,
        planner: [...prev.planner, { ...item, id: nextId() }]
      };
    });
  };

  const markPlannerStatus = (id, status) => {
    setData((prev) => ({
      ...prev,
      planner: prev.planner.map((p) => (p.id === id ? { ...p, status } : p))
    }));
  };

  // ---- simple forms local state ----
  const [clientForm, setClientForm] = useState({
    name: "",
    brand: "",
    retainer: "",
    notes: ""
  });

  const addClient = () => {
    if (!clientForm.name.trim()) return;
    const newClient = {
      id: nextId(),
      name: clientForm.name.trim(),
      brand: clientForm.brand.trim(),
      retainer: Number(clientForm.retainer || 0),
      startDate: format(today, "yyyy-MM-dd"),
      status: "active",
      notes: clientForm.notes
    };
    setData((prev) => ({ ...prev, clients: [...prev.clients, newClient] }));
    setClientForm({ name: "", brand: "", retainer: "", notes: "" });
  };

  const [plannerForm, setPlannerForm] = useState({
    clientId: "",
    date: format(today, "yyyy-MM-dd"),
    platform: "Instagram",
    type: "Post",
    title: "",
    caption: ""
  });

  const submitPlannerForm = () => {
    if (!plannerForm.clientId || !plannerForm.date) return;
    upsertPlannerItem({
      id: nextId(),
      clientId: Number(plannerForm.clientId),
      date: plannerForm.date,
      platform: plannerForm.platform,
      type: plannerForm.type,
      title: plannerForm.title,
      caption: plannerForm.caption,
      status: "planned"
    });
    setPlannerForm((prev) => ({ ...prev, title: "", caption: "" }));
  };

  const [effortForm, setEffortForm] = useState({
    clientId: "",
    date: format(today, "yyyy-MM-dd"),
    posts: "",
    reels: "",
    minutes: "",
    notes: ""
  });

  const submitEffort = () => {
    if (!effortForm.clientId || !effortForm.date) return;
    const newLog = {
      id: nextId(),
      clientId: Number(effortForm.clientId),
      date: effortForm.date,
      posts: Number(effortForm.posts || 0),
      reels: Number(effortForm.reels || 0),
      minutes: Number(effortForm.minutes || 0),
      notes: effortForm.notes
    };
    setData((prev) => ({ ...prev, efforts: [newLog, ...prev.efforts] }));
    setEffortForm({ ...effortForm, posts: "", reels: "", minutes: "", notes: "" });
  };

  const [taskForm, setTaskForm] = useState({
    title: "",
    description: "",
    clientId: "",
    assignee: "",
    status: "pending",
    priority: "medium",
    dueDate: ""
  });

  const submitTask = () => {
    if (!taskForm.title.trim()) return;
    const newTask = {
      id: nextId(),
      title: taskForm.title.trim(),
      description: taskForm.description,
      clientId: taskForm.clientId ? Number(taskForm.clientId) : null,
      assignee: taskForm.assignee.trim(),
      status: taskForm.status,
      priority: taskForm.priority,
      dueDate: taskForm.dueDate
    };
    setData((prev) => ({ ...prev, tasks: [newTask, ...prev.tasks] }));
    setTaskForm({
      title: "",
      description: "",
      clientId: "",
      assignee: "",
      status: "pending",
      priority: "medium",
      dueDate: ""
    });
  };

  const updateTaskStatus = (id, status) => {
    setData((prev) => ({
      ...prev,
      tasks: prev.tasks.map((t) => (t.id === id ? { ...t, status } : t))
    }));
  };

  const [invoiceForm, setInvoiceForm] = useState({
    clientId: "",
    month: format(today, "yyyy-MM"),
    amount: "",
    dueDate: format(today, "yyyy-MM-dd")
  });

  const submitInvoice = () => {
    if (!invoiceForm.clientId || !invoiceForm.amount) return;
    const inv = {
      id: nextId(),
      clientId: Number(invoiceForm.clientId),
      month: invoiceForm.month,
      amount: Number(invoiceForm.amount),
      dueDate: invoiceForm.dueDate,
      status: "pending"
    };
    setData((prev) => ({ ...prev, invoices: [inv, ...prev.invoices] }));
    setInvoiceForm((prev) => ({ ...prev, amount: "" }));
  };

  const markInvoicePaid = (id) => {
    const paidDate = format(today, "yyyy-MM-dd");
    setData((prev) => ({
      ...prev,
      invoices: prev.invoices.map((inv) =>
        inv.id === id ? { ...inv, status: "paid", paidDate } : inv
      )
    }));
  };

  const [projectionForm, setProjectionForm] = useState({
    startDate: format(startOfMonth(today), "yyyy-MM-dd"),
    endDate: format(endOfMonth(today), "yyyy-MM-dd"),
    type: "monthly",
    revenueTarget: "",
    clientTarget: "",
    note: ""
  });

  const submitProjection = () => {
    if (!projectionForm.startDate || !projectionForm.endDate) return;
    const proj = {
      id: nextId(),
      startDate: projectionForm.startDate,
      endDate: projectionForm.endDate,
      type: projectionForm.type,
      revenueTarget: Number(projectionForm.revenueTarget || 0),
      clientTarget: Number(projectionForm.clientTarget || 0),
      note: projectionForm.note
    };
    setData((prev) => ({ ...prev, projections: [proj, ...prev.projections] }));
  };

  const [searchQuery, setSearchQuery] = useState("");

  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return { clients: [], planner: [], tasks: [], invoices: [] };
    const contains = (str) => (str || "").toLowerCase().includes(q);

    const clients = data.clients.filter(
      (c) => contains(c.name) || contains(c.brand) || contains(c.notes)
    );
    const planner = data.planner.filter(
      (p) =>
        contains(p.title) ||
        contains(p.caption) ||
        contains(clientsMap.get(p.clientId)?.name || "")
    );
    const tasks = data.tasks.filter(
      (t) => contains(t.title) || contains(t.description) || contains(t.assignee)
    );
    const invoices = data.invoices.filter((inv) =>
      contains(clientsMap.get(inv.clientId)?.name || "")
    );
    return { clients, planner, tasks, invoices };
  }, [searchQuery, data, clientsMap]);

  const totalPendingAmount = data.invoices
    .filter((inv) => inv.status !== "paid")
    .reduce((sum, inv) => sum + Number(inv.amount || 0), 0);

  // ---------------- RENDER TABS ----------------

  const renderDashboard = () => (
    <>
      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Super Calendar · Today</div>
              <div className="card-subtitle">
                {format(today, "EEEE, dd MMM yyyy")}
              </div>
            </div>
            <span className="badge-pill">
              {dashboardSections.todayItems.length} item(s)
            </span>
          </div>
          {dashboardSections.todayItems.length === 0 ? (
            <p className="text-muted">No content planned for today yet.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Platform</th>
                  <th>Type</th>
                  <th>Title</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {dashboardSections.todayItems.map((it) => (
                  <tr key={it.id}>
                    <td>{clientsMap.get(it.clientId)?.name || "-"}</td>
                    <td>{it.platform}</td>
                    <td>{it.type}</td>
                    <td>{it.title || "-"}</td>
                    <td>
                      <span className={`status-chip ${STATUS_COLORS[it.status] || ""}`}>
                        {it.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">This Week Snapshot</div>
              <div className="card-subtitle">
                Next 3 days · previous 3 days around today
              </div>
            </div>
            <span className="badge-pill">
              {dashboardSections.weekItems.length} item(s)
            </span>
          </div>
          {dashboardSections.weekItems.length === 0 ? (
            <p className="text-muted">Add posts in Planner to see a weekly view.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Client</th>
                  <th>Platform</th>
                  <th>Type</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {dashboardSections.weekItems.map((it) => (
                  <tr key={it.id}>
                    <td>{format(parseISO(it.date), "dd MMM")}</td>
                    <td>{clientsMap.get(it.clientId)?.name || "-"}</td>
                    <td>{it.platform}</td>
                    <td>{it.type}</td>
                    <td>
                      <span className={`status-chip ${STATUS_COLORS[it.status] || ""}`}>
                        {it.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="grid-3">
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Overdue · Content</div>
              <div className="card-subtitle">
                Items not marked done before their date.
              </div>
            </div>
            <span className="badge-pill">
              {dashboardSections.overdueItems.length}
            </span>
          </div>
          {dashboardSections.overdueItems.length === 0 ? (
            <p className="text-muted">No overdue posts right now 🎉</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Client</th>
                  <th>Title</th>
                </tr>
              </thead>
              <tbody>
                {dashboardSections.overdueItems.map((it) => (
                  <tr key={it.id}>
                    <td>{format(parseISO(it.date), "dd MMM")}</td>
                    <td>{clientsMap.get(it.clientId)?.name || "-"}</td>
                    <td>{it.title || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Overdue · Collections</div>
              <div className="card-subtitle">
                Invoices whose due date has passed &amp; not paid.
              </div>
            </div>
            <span className="badge-pill">
              ₹
              {dashboardSections.overdueInvoices
                .reduce((s, x) => s + Number(x.amount || 0), 0)
                .toLocaleString("en-IN")}
            </span>
          </div>
          {dashboardSections.overdueInvoices.length === 0 ? (
            <p className="text-muted">No overdue invoices 🟢</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Month</th>
                  <th>Due</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {dashboardSections.overdueInvoices.map((inv) => (
                  <tr key={inv.id}>
                    <td>{clientsMap.get(inv.clientId)?.name || "-"}</td>
                    <td>{inv.month}</td>
                    <td>{format(parseISO(inv.dueDate), "dd MMM")}</td>
                    <td>₹{Number(inv.amount || 0).toLocaleString("en-IN")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Effort Radar · last 30 days</div>
              <div className="card-subtitle">Time distribution across brands.</div>
            </div>
          </div>
          {dashboardSections.summary.length === 0 ? (
            <p className="text-muted">Add Effort logs to unlock this view.</p>
          ) : (
            <>
              <table className="table">
                <thead>
                  <tr>
                    <th>Client</th>
                    <th>Minutes</th>
                    <th>%</th>
                  </tr>
                </thead>
                <tbody>
                  {dashboardSections.summary.map((r) => (
                    <tr key={r.clientId}>
                      <td>{r.name}</td>
                      <td>{r.minutes}</td>
                      <td>{r.pct.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {dashboardSections.top && (
                <p className="mt-8 text-muted">
                  ⏱ Top focus:{" "}
                  <span className="highlight">
                    {dashboardSections.top.name}
                  </span>{" "}
                  with {dashboardSections.top.minutes} minutes.
                </p>
              )}
            </>
          )}
        </div>
      </div>

      <div className="grid-2 mt-12">
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Projection Wall</div>
              <div className="card-subtitle">
                Live progress against your current target.
              </div>
            </div>
            {dashboardSections.activeProjection && (
              <span className="badge-pill">
                {format(parseISO(dashboardSections.activeProjection.startDate), "dd MMM")} –{" "}
                {format(parseISO(dashboardSections.activeProjection.endDate), "dd MMM")}
              </span>
            )}
          </div>
          {!dashboardSections.activeProjection ? (
            <p className="text-muted">
              Create a projection in the <span className="highlight">Projection</span> tab to
              see this fill up.
            </p>
          ) : (
            <>
              <p className="text-muted">
                Target:{" "}
                <span className="highlight">
                  ₹{dashboardSections.activeProjection.revenueTarget.toLocaleString("en-IN")}
                </span>{" "}
                &nbsp;·&nbsp;
                <span className="highlight">
                  {dashboardSections.activeProjection.clientTarget} clients
                </span>
              </p>
              <p className="text-muted">
                Achieved:{" "}
                <span className="highlight">
                  ₹
                  {dashboardSections.projectionProgress.achievedRevenue.toLocaleString(
                    "en-IN"
                  )}
                </span>{" "}
                (
                {dashboardSections.projectionProgress.revenuePct}
                %)
                &nbsp;·&nbsp;
                <span className="highlight">
                  {dashboardSections.projectionProgress.achievedClients} clients
                </span>{" "}
                ({dashboardSections.projectionProgress.clientPct}
                %)
              </p>
            </>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Financial Snapshot</div>
              <div className="card-subtitle">
                Pending receivables across all retainers.
              </div>
            </div>
            <span className="badge-pill">
              Pending ₹{totalPendingAmount.toLocaleString("en-IN")}
            </span>
          </div>
          <p className="text-muted">
            Use the <span className="highlight">Accounts</span> tab to add invoices and mark them
            as paid. Anything beyond the due date turns red automatically.
          </p>
        </div>
      </div>
    </>
  );

  const renderClients = () => (
    <>
      <div className="section-title-row">
        <h3>Clients</h3>
        <span>{data.clients.length} active records</span>
      </div>

      <div className="card mb-8">
        <div className="card-header">
          <div className="card-title">Add / Update Client</div>
        </div>
        <div className="input-row">
          <input
            placeholder="Client name *"
            value={clientForm.name}
            onChange={(e) => setClientForm({ ...clientForm, name: e.target.value })}
          />
          <input
            placeholder="Brand / handle"
            value={clientForm.brand}
            onChange={(e) => setClientForm({ ...clientForm, brand: e.target.value })}
          />
          <input
            placeholder="Monthly retainer (₹)"
            type="number"
            value={clientForm.retainer}
            onChange={(e) => setClientForm({ ...clientForm, retainer: e.target.value })}
          />
        </div>
        <div className="input-row">
          <textarea
            placeholder="Notes (scope, deliverables, important info)"
            value={clientForm.notes}
            onChange={(e) => setClientForm({ ...clientForm, notes: e.target.value })}
          />
        </div>
        <button className="btn-primary mt-8" onClick={addClient}>
          Save client
        </button>
      </div>

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Brand</th>
              <th>Retainer</th>
              <th>Since</th>
            </tr>
          </thead>
          <tbody>
            {data.clients.length === 0 ? (
              <tr>
                <td colSpan={4} className="text-muted">
                  No clients yet. Add your first one above.
                </td>
              </tr>
            ) : (
              data.clients.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>{c.brand || "-"}</td>
                  <td>₹{Number(c.retainer || 0).toLocaleString("en-IN")}</td>
                  <td>{c.startDate || "-"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );

  const renderPlanner = () => {
    const monthStr = format(today, "yyyy-MM");
    const start = startOfMonth(today);
    const end = endOfMonth(today);
    const thisMonthItems = data.planner.filter(
      (p) => p.date >= format(start, "yyyy-MM-dd") && p.date <= format(end, "yyyy-MM-dd")
    );
    thisMonthItems.sort((a, b) => (a.date > b.date ? 1 : -1));

    return (
      <>
        <div className="section-title-row">
          <h3>Content Planner</h3>
          <span>
            {format(start, "dd MMM")} – {format(end, "dd MMM yyyy")} ({thisMonthItems.length}{" "}
            items)
          </span>
        </div>

        <div className="card mb-8">
          <div className="card-header">
            <div className="card-title">Plan a Post / Reel</div>
          </div>
          <div className="input-row">
            <select
              value={plannerForm.clientId}
              onChange={(e) => setPlannerForm({ ...plannerForm, clientId: e.target.value })}
            >
              <option value="">Select client *</option>
              {data.clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <input
              type="date"
              value={plannerForm.date}
              onChange={(e) => setPlannerForm({ ...plannerForm, date: e.target.value })}
            />
            <select
              value={plannerForm.platform}
              onChange={(e) => setPlannerForm({ ...plannerForm, platform: e.target.value })}
            >
              <option>Instagram</option>
              <option>Facebook</option>
              <option>LinkedIn</option>
              <option>YouTube</option>
              <option>Website / Blog</option>
            </select>
            <select
              value={plannerForm.type}
              onChange={(e) => setPlannerForm({ ...plannerForm, type: e.target.value })}
            >
              <option>Post</option>
              <option>Reel</option>
              <option>Story</option>
              <option>Ad Creative</option>
              <option>Emailer</option>
            </select>
          </div>
          <div className="input-row">
            <input
              placeholder="Hook / title"
              value={plannerForm.title}
              onChange={(e) => setPlannerForm({ ...plannerForm, title: e.target.value })}
            />
            <textarea
              placeholder="Caption / idea notes"
              value={plannerForm.caption}
              onChange={(e) => setPlannerForm({ ...plannerForm, caption: e.target.value })}
            />
          </div>
          <button className="btn-primary mt-8" onClick={submitPlannerForm}>
            Add to planner
          </button>
        </div>

        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Client</th>
                <th>Platform</th>
                <th>Type</th>
                <th>Title</th>
                <th>Status</th>
                <th>Mark</th>
              </tr>
            </thead>
            <tbody>
              {thisMonthItems.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-muted">
                    Nothing planned for this month yet.
                  </td>
                </tr>
              ) : (
                thisMonthItems.map((it) => (
                  <tr key={it.id}>
                    <td>{format(parseISO(it.date), "dd MMM")}</td>
                    <td>{clientsMap.get(it.clientId)?.name || "-"}</td>
                    <td>{it.platform}</td>
                    <td>{it.type}</td>
                    <td>{it.title || "-"}</td>
                    <td>
                      <span className={`status-chip ${STATUS_COLORS[it.status] || ""}`}>
                        {it.status}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 4 }}>
                        <button
                          className="btn-secondary"
                          onClick={() => markPlannerStatus(it.id, "done")}
                        >
                          Done
                        </button>
                        <button
                          className="btn-secondary"
                          onClick={() => markPlannerStatus(it.id, "skipped")}
                        >
                          Skip
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </>
    );
  };

  const renderEfforts = () => {
    const recentLogs = [...data.efforts].sort((a, b) =>
      a.date > b.date ? -1 : 1
    );

    return (
      <>
        <div className="section-title-row">
          <h3>Effort Tracker</h3>
          <span>Time + posts + reels per client</span>
        </div>

        <div className="card mb-8">
          <div className="card-header">
            <div className="card-title">Log Today&apos;s Effort</div>
          </div>
          <div className="input-row">
            <select
              value={effortForm.clientId}
              onChange={(e) =>
                setEffortForm({ ...effortForm, clientId: e.target.value })
              }
            >
              <option value="">Client *</option>
              {data.clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <input
              type="date"
              value={effortForm.date}
              onChange={(e) => setEffortForm({ ...effortForm, date: e.target.value })}
            />
            <input
              type="number"
              placeholder="Posts"
              value={effortForm.posts}
              onChange={(e) => setEffortForm({ ...effortForm, posts: e.target.value })}
            />
            <input
              type="number"
              placeholder="Reels"
              value={effortForm.reels}
              onChange={(e) => setEffortForm({ ...effortForm, reels: e.target.value })}
            />
            <input
              type="number"
              placeholder="Minutes spent"
              value={effortForm.minutes}
              onChange={(e) => setEffortForm({ ...effortForm, minutes: e.target.value })}
            />
          </div>
          <div className="input-row">
            <textarea
              placeholder="What did you work on? (optional)"
              value={effortForm.notes}
              onChange={(e) => setEffortForm({ ...effortForm, notes: e.target.value })}
            />
          </div>
          <button className="btn-primary mt-8" onClick={submitEffort}>
            Save effort
          </button>
        </div>

        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Client</th>
                <th>Posts</th>
                <th>Reels</th>
                <th>Minutes</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {recentLogs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-muted">
                    No effort logged yet.
                  </td>
                </tr>
              ) : (
                recentLogs.map((log) => (
                  <tr key={log.id}>
                    <td>{log.date}</td>
                    <td>{clientsMap.get(log.clientId)?.name || "-"}</td>
                    <td>{log.posts}</td>
                    <td>{log.reels}</td>
                    <td>{log.minutes}</td>
                    <td>{log.notes || "-"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </>
    );
  };

  const renderTasks = () => {
    const grouped = {
      pending: [],
      in_progress: [],
      completed: [],
      overdue: []
    };
    data.tasks.forEach((t) => {
      grouped[t.status] = grouped[t.status] || [];
      grouped[t.status].push(t);
    });

    const column = (title, key) => (
      <div className="card" key={key}>
        <div className="card-header">
          <div className="card-title">{title}</div>
          <span className="badge-pill">{grouped[key].length}</span>
        </div>
        {grouped[key].length === 0 ? (
          <p className="text-muted">No tasks in this lane.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Client</th>
                <th>Assignee</th>
                <th>Due</th>
                <th>Move</th>
              </tr>
            </thead>
            <tbody>
              {grouped[key].map((t) => (
                <tr key={t.id}>
                  <td>{t.title}</td>
                  <td>{t.clientId ? clientsMap.get(t.clientId)?.name : "-"}</td>
                  <td>{t.assignee || "-"}</td>
                  <td>{t.dueDate || "-"}</td>
                  <td>
                    <div style={{ display: "flex", gap: 4 }}>
                      {["pending", "in_progress", "completed", "overdue"].map((st) => (
                        <button
                          key={st}
                          className="btn-secondary"
                          onClick={() => updateTaskStatus(t.id, st)}
                        >
                          {st.replace("_", " ")}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    );

    return (
      <>
        <div className="section-title-row">
          <h3>Task Board</h3>
          <span>Assign, track and close actions.</span>
        </div>

        <div className="card mb-8">
          <div className="card-header">
            <div className="card-title">Create a Task</div>
          </div>
          <div className="input-row">
            <input
              placeholder="Task title *"
              value={taskForm.title}
              onChange={(e) => setTaskForm({ ...taskForm, title: e.target.value })}
            />
            <select
              value={taskForm.clientId}
              onChange={(e) => setTaskForm({ ...taskForm, clientId: e.target.value })}
            >
              <option value="">Client (optional)</option>
              {data.clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <input
              placeholder="Assignee name"
              value={taskForm.assignee}
              onChange={(e) => setTaskForm({ ...taskForm, assignee: e.target.value })}
            />
            <input
              type="date"
              value={taskForm.dueDate}
              onChange={(e) => setTaskForm({ ...taskForm, dueDate: e.target.value })}
            />
          </div>
          <div className="input-row">
            <select
              value={taskForm.status}
              onChange={(e) => setTaskForm({ ...taskForm, status: e.target.value })}
            >
              <option value="pending">Pending</option>
              <option value="in_progress">In progress</option>
              <option value="completed">Completed</option>
              <option value="overdue">Overdue</option>
            </select>
            <select
              value={taskForm.priority}
              onChange={(e) => setTaskForm({ ...taskForm, priority: e.target.value })}
            >
              <option value="low">Low priority</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </div>
          <div className="input-row">
            <textarea
              placeholder="Details / acceptance criteria"
              value={taskForm.description}
              onChange={(e) => setTaskForm({ ...taskForm, description: e.target.value })}
            />
          </div>
          <button className="btn-primary mt-8" onClick={submitTask}>
            Add task
          </button>
        </div>

        <div className="grid-3">
          {column("Backlog / Pending", "pending")}
          {column("In Progress", "in_progress")}
          {column("Completed", "completed")}
          {column("Overdue", "overdue")}
        </div>
      </>
    );
  };

  const renderAccounts = () => {
    const sorted = [...data.invoices].sort((a, b) => (a.dueDate > b.dueDate ? 1 : -1));

    return (
      <>
        <div className="section-title-row">
          <h3>Accounts · Invoices & Collections</h3>
          <span>Per-client ledger of retainers.</span>
        </div>

        <div className="card mb-8">
          <div className="card-header">
            <div className="card-title">Create an Invoice</div>
          </div>
          <div className="input-row">
            <select
              value={invoiceForm.clientId}
              onChange={(e) =>
                setInvoiceForm({ ...invoiceForm, clientId: e.target.value })
              }
            >
              <option value="">Client *</option>
              {data.clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <input
              type="month"
              value={invoiceForm.month}
              onChange={(e) => setInvoiceForm({ ...invoiceForm, month: e.target.value })}
            />
            <input
              type="number"
              placeholder="Amount (₹)"
              value={invoiceForm.amount}
              onChange={(e) => setInvoiceForm({ ...invoiceForm, amount: e.target.value })}
            />
            <input
              type="date"
              value={invoiceForm.dueDate}
              onChange={(e) => setInvoiceForm({ ...invoiceForm, dueDate: e.target.value })}
            />
          </div>
          <button className="btn-primary mt-8" onClick={submitInvoice}>
            Save invoice
          </button>
        </div>

        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>Client</th>
                <th>Month</th>
                <th>Due date</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-muted">
                    No invoices yet.
                  </td>
                </tr>
              ) : (
                sorted.map((inv) => (
                  <tr key={inv.id}>
                    <td>{clientsMap.get(inv.clientId)?.name || "-"}</td>
                    <td>{inv.month}</td>
                    <td>{inv.dueDate}</td>
                    <td>₹{Number(inv.amount || 0).toLocaleString("en-IN")}</td>
                    <td>
                      <span
                        className={`status-chip ${
                          inv.status === "paid"
                            ? "status-paid"
                            : inv.status === "overdue"
                            ? "status-overdue"
                            : "status-pending"
                        }`}
                      >
                        {inv.status}
                      </span>
                    </td>
                    <td>
                      {inv.status !== "paid" && (
                        <button
                          className="btn-secondary"
                          onClick={() => markInvoicePaid(inv.id)}
                        >
                          Mark paid
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </>
    );
  };

  const renderProjection = () => (
    <>
      <div className="section-title-row">
        <h3>Projection Wall</h3>
        <span>Turn yearly goals into visual progress.</span>
      </div>

      <div className="card mb-8">
        <div className="card-header">
          <div className="card-title">Set / Update Projection</div>
        </div>
        <div className="input-row">
          <input
            type="date"
            value={projectionForm.startDate}
            onChange={(e) =>
              setProjectionForm({ ...projectionForm, startDate: e.target.value })
            }
          />
          <input
            type="date"
            value={projectionForm.endDate}
            onChange={(e) =>
              setProjectionForm({ ...projectionForm, endDate: e.target.value })
            }
          />
          <select
            value={projectionForm.type}
            onChange={(e) =>
              setProjectionForm({ ...projectionForm, type: e.target.value })
            }
          >
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
            <option value="yearly">Yearly</option>
          </select>
          <input
            type="number"
            placeholder="Target revenue (₹)"
            value={projectionForm.revenueTarget}
            onChange={(e) =>
              setProjectionForm({ ...projectionForm, revenueTarget: e.target.value })
            }
          />
          <input
            type="number"
            placeholder="Target clients"
            value={projectionForm.clientTarget}
            onChange={(e) =>
              setProjectionForm({ ...projectionForm, clientTarget: e.target.value })
            }
          />
        </div>
        <div className="input-row">
          <textarea
            placeholder="Describe this projection / theme."
            value={projectionForm.note}
            onChange={(e) =>
              setProjectionForm({ ...projectionForm, note: e.target.value })
            }
          />
        </div>
        <button className="btn-primary mt-8" onClick={submitProjection}>
          Save projection
        </button>
      </div>

      <div className="card">
        <div className="card-header">
          <div className="card-title">All Projections</div>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Period</th>
              <th>Type</th>
              <th>Revenue target</th>
              <th>Client target</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {data.projections.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-muted">
                  No projections set yet.
                </td>
              </tr>
            ) : (
              data.projections.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.startDate} → {p.endDate}
                  </td>
                  <td>{p.type}</td>
                  <td>₹{Number(p.revenueTarget || 0).toLocaleString("en-IN")}</td>
                  <td>{p.clientTarget}</td>
                  <td>{p.note || "-"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );

  const renderSearch = () => (
    <>
      <div className="section-title-row">
        <h3>Global Search</h3>
        <span>Find any client, post, task or invoice quickly.</span>
      </div>

      <div className="card mb-8">
        <input
          placeholder="Type anything: client name, idea, task, invoice..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      {searchQuery && (
        <div className="grid-3">
          <div className="card">
            <div className="card-title">Clients</div>
            <ul style={{ fontSize: 12, paddingLeft: 16 }}>
              {searchResults.clients.length === 0 ? (
                <li className="text-muted">No match</li>
              ) : (
                searchResults.clients.map((c) => (
                  <li key={c.id}>
                    <span className="highlight">{c.name}</span> · {c.brand}
                  </li>
                ))
              )}
            </ul>
          </div>
          <div className="card">
            <div className="card-title">Planned Content</div>
            <ul style={{ fontSize: 12, paddingLeft: 16 }}>
              {searchResults.planner.length === 0 ? (
                <li className="text-muted">No match</li>
              ) : (
                searchResults.planner.map((p) => (
                  <li key={p.id}>
                    {p.date} ·{" "}
                    <span className="highlight">
                      {clientsMap.get(p.clientId)?.name || "-"}
                    </span>{" "}
                    · {p.title || p.caption}
                  </li>
                ))
              )}
            </ul>
          </div>
          <div className="card">
            <div className="card-title">Tasks & Invoices</div>
            <ul style={{ fontSize: 12, paddingLeft: 16 }}>
              {searchResults.tasks.length === 0 &&
              searchResults.invoices.length === 0 ? (
                <li className="text-muted">No match</li>
              ) : (
                <>
                  {searchResults.tasks.map((t) => (
                    <li key={t.id}>
                      📝 <span className="highlight">{t.title}</span> ·{" "}
                      {t.assignee || "-"}
                    </li>
                  ))}
                  {searchResults.invoices.map((inv) => (
                    <li key={inv.id}>
                      💰 <span className="highlight">
                        {clientsMap.get(inv.clientId)?.name || "-"}
                      </span>{" "}
                      · {inv.month} · ₹
                      {Number(inv.amount || 0).toLocaleString("en-IN")} (
                      {inv.status})
                    </li>
                  ))}
                </>
              )}
            </ul>
          </div>
        </div>
      )}
    </>
  );

  const renderTabContent = () => {
    switch (tab) {
      case "clients":
        return renderClients();
      case "planner":
        return renderPlanner();
      case "efforts":
        return renderEfforts();
      case "tasks":
        return renderTasks();
      case "accounts":
        return renderAccounts();
      case "projection":
        return renderProjection();
      case "search":
        return renderSearch();
      case "dashboard":
      default:
        return renderDashboard();
    }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div>
          <div className="sidebar-logo">Web Wonders · Studio OS</div>
          <div className="sidebar-tagline">
            One clean cockpit for all your digital marketing clients.
          </div>
        </div>

        <div>
          <div className="nav-section-title">Overview</div>
          <div className="nav-list">
            <div
              className={`nav-item ${tab === "dashboard" ? "active" : ""}`}
              onClick={() => setTab("dashboard")}
            >
              <span>Dashboard</span>
              <span className="nav-badge">Today</span>
            </div>
          </div>
        </div>

        <div>
          <div className="nav-section-title">Operations</div>
          <div className="nav-list">
            <div
              className={`nav-item ${tab === "clients" ? "active" : ""}`}
              onClick={() => setTab("clients")}
            >
              <span>Clients</span>
              <span className="nav-badge">{data.clients.length}</span>
            </div>
            <div
              className={`nav-item ${tab === "planner" ? "active" : ""}`}
              onClick={() => setTab("planner")}
            >
              <span>Planner</span>
              <span className="nav-badge">{data.planner.length}</span>
            </div>
            <div
              className={`nav-item ${tab === "efforts" ? "active" : ""}`}
              onClick={() => setTab("efforts")}
            >
              <span>Efforts</span>
              <span className="nav-badge">{data.efforts.length}</span>
            </div>
            <div
              className={`nav-item ${tab === "tasks" ? "active" : ""}`}
              onClick={() => setTab("tasks")}
            >
              <span>Tasks</span>
              <span className="nav-badge">{data.tasks.length}</span>
            </div>
            <div
              className={`nav-item ${tab === "accounts" ? "active" : ""}`}
              onClick={() => setTab("accounts")}
            >
              <span>Accounts</span>
              <span className="nav-badge">
                ₹{totalPendingAmount.toLocaleString("en-IN")}
              </span>
            </div>
            <div
              className={`nav-item ${tab === "projection" ? "active" : ""}`}
              onClick={() => setTab("projection")}
            >
              <span>Projection Wall</span>
            </div>
            <div
              className={`nav-item ${tab === "search" ? "active" : ""}`}
              onClick={() => setTab("search")}
            >
              <span>Search</span>
            </div>
          </div>
        </div>

        <div className="sidebar-footer">
          Data is stored in your browser (localStorage).  
          Backup by exporting later if needed.
        </div>
      </aside>

      <main className="main">
        <div className="main-header">
          <div>
            <div className="main-title">
              {tab === "dashboard"
                ? "Mission Control"
                : tab.charAt(0).toUpperCase() + tab.slice(1)}
            </div>
            <div className="main-subtitle">
              {format(today, "dd MMM yyyy")} · Web Wonders
            </div>
          </div>
          <div className="chip">Studio ready · local data</div>
        </div>

        {renderTabContent()}
      </main>
    </div>
  );
}
