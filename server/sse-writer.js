// Server-Sent Events for /api/run, with a bound on what waits in memory.
//
// k6 output lines (`log`) are the one event a script controls the rate of: a
// console.log in a tight loop prints as fast as k6 can. While the connection is backed
// up (res.write() returned false), `log` events are left out and counted; once it
// drains, one `log` line says how many, and they flow again. Every other event is always
// written: each has its own limit (request records 50 + 50 a second, Save to CSV rows
// batched and capped, metrics once a second, done once). The browser keeps only the
// most recent k6 output lines anyway (public/js/live-log.js).

export const droppedLogLine = (count) =>
  `… K6UI left out ${count} line${count === 1 ? "" : "s"} of k6 output: they came faster than the browser could take them.\n`;

// → write(event, data) for this response.
export function createSseWriter(res) {
  let blocked = false;
  let dropped = 0;

  function send(event, data) {
    if (!res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) blocked = true;
  }

  function reportDropped() {
    if (!dropped) return;
    const count = dropped;
    dropped = 0;
    send("log", { line: droppedLogLine(count) });
  }

  res.on("drain", () => {
    blocked = false;
    reportDropped();
  });

  return function write(event, data) {
    if (event === "log" && blocked) {
      dropped += 1;
      return;
    }
    // The count goes out before the end, so a run that ends backed up still says it.
    if (event === "done" || event === "error") reportDropped();
    send(event, data);
  };
}
