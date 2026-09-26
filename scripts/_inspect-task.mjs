const taskGid = process.argv[2];
const token = process.env.ASANA_ACCESS_TOKEN;
const headers = { Authorization: `Bearer ${token}` };

async function asanaGet(path) {
  const response = await fetch(`https://app.asana.com/api/1.0${path}`, { headers });
  const payload = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(payload));
  return payload.data;
}

const task = await asanaGet(
  `/tasks/${taskGid}?opt_fields=name,completed,assignee.gid,assignee.name,parent.gid,parent.name,notes,html_notes,due_on,due_at,modified_at,created_by.gid,created_by.name`,
);
const parent = task.parent?.gid
  ? await asanaGet(
    `/tasks/${task.parent.gid}?opt_fields=name,completed,assignee.gid,notes,html_notes,modified_at`,
  )
  : null;
const subtasks = await asanaGet(
  `/tasks/${taskGid}/subtasks?opt_fields=name,completed,assignee.gid,assignee.name,notes,html_notes`,
);

console.log(JSON.stringify({ task, parent, subtasks }, null, 2));
