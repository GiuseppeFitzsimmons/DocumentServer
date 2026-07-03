#!/usr/bin/env python3
"""
EuroBureau Deploy Helper
A Tkinter-based GUI for running deployment commands over SSH.
"""

import tkinter as tk
from tkinter import ttk, messagebox
import paramiko
import threading
import subprocess
import os
import re
from datetime import datetime

# Regex to strip ANSI escape sequences
ANSI_ESCAPE = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[^[\]](.|$)")

# === Configuration ===

ENVIRONMENTS = {
    "dev": {
        "host": "178.105.119.64",
        "user": "root",
        "label": "Dev Server",
    },
    "prod": {
        "host": "188.245.126.65",
        "user": "root",
        "label": "Prod Server",
    },
    "prod-proxy": {
        "host": "162.55.44.102",
        "user": "root",
        "label": "Prod Proxy",
    },
}

# Commands are lists of (description, shell_command) tuples.
# They run sequentially in a single SSH session.
ACTIONS = {
    "Update Server": {
        "targets": ["dev", "prod"],
        "commands": [
            "cd /opt/euro-office/repo && git fetch && git checkout main && git pull",
            "cd /opt/euro-office/repo/deploy && docker compose up -d --build",
            "cd /opt/euro-office/repo/deploy && docker compose exec portal node dist/db/migrate.js",
        ],
    },
    "Update Fonts": {
        "targets": ["dev", "prod"],
        "commands": [
            "cd /opt/euro-office/repo/fonts && git pull",
            "cd /opt/euro-office/repo/deploy && docker compose build --no-cache documentserver",
            "cd /opt/euro-office/repo/deploy && docker compose up -d documentserver",
        ],
    },
    "View Logs": {
        "targets": ["dev", "prod"],
        "special": "stream_logs",
        "command": "cd /opt/euro-office/repo/deploy && docker compose logs portal -t --tail 100 -f",
    },
    "Update Proxy Config": {
        "targets": ["prod-proxy"],
        "special": "proxy_update",
    },
    "Update Nginx Config": {
        "targets": ["dev"],
        "commands": [
            "cp /opt/euro-office/repo/deploy/nginx/nginx-dev.conf /etc/nginx/sites-available/dev.conf",
            "certbot --nginx -d dev.eurobureau.eu --non-interactive --agree-tos -m admin@eurobureau.eu",
        ],
    },
    "Database Shell": {
        "targets": ["dev", "prod"],
        "special": "db_shell",
    },
}

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class DeployHelper:
    def __init__(self, root):
        self.root = root
        self.root.title("EuroBureau Deploy Helper")
        self.root.geometry("900x620")
        self.root.minsize(700, 500)

        self.running = False
        self.current_thread = None

        self._build_ui()

    def _build_ui(self):
        # Top frame: environment + action selection
        top_frame = ttk.Frame(self.root, padding=10)
        top_frame.pack(fill=tk.X)

        ttk.Label(top_frame, text="Environment:").pack(side=tk.LEFT, padx=(0, 5))
        self.env_var = tk.StringVar(value="dev")
        env_menu = ttk.Combobox(
            top_frame,
            textvariable=self.env_var,
            values=list(ENVIRONMENTS.keys()),
            state="readonly",
            width=12,
        )
        env_menu.pack(side=tk.LEFT, padx=(0, 15))
        env_menu.bind("<<ComboboxSelected>>", self._on_env_change)

        ttk.Label(top_frame, text="Action:").pack(side=tk.LEFT, padx=(0, 5))
        self.action_var = tk.StringVar(value=list(ACTIONS.keys())[0])
        self.action_menu = ttk.Combobox(
            top_frame,
            textvariable=self.action_var,
            values=self._get_available_actions(),
            state="readonly",
            width=20,
        )
        self.action_menu.pack(side=tk.LEFT, padx=(0, 15))

        self.run_btn = ttk.Button(top_frame, text="Run", command=self._run_action)
        self.run_btn.pack(side=tk.LEFT, padx=(0, 5))

        self.stop_btn = ttk.Button(
            top_frame, text="Stop", command=self._stop_action, state=tk.DISABLED
        )
        self.stop_btn.pack(side=tk.LEFT, padx=(0, 5))

        self.clear_btn = ttk.Button(
            top_frame, text="Clear", command=self._clear_output
        )
        self.clear_btn.pack(side=tk.RIGHT)

        # Status bar
        status_frame = ttk.Frame(self.root, padding=(10, 0))
        status_frame.pack(fill=tk.X)
        self.status_var = tk.StringVar(value="Ready")
        self.status_label = ttk.Label(
            status_frame, textvariable=self.status_var, foreground="gray"
        )
        self.status_label.pack(side=tk.LEFT)

        # Console output
        console_frame = ttk.Frame(self.root, padding=10)
        console_frame.pack(fill=tk.BOTH, expand=True)

        self.console = tk.Text(
            console_frame,
            bg="#1e1e1e",
            fg="#d4d4d4",
            font=("Consolas", 10),
            wrap=tk.WORD,
            state=tk.DISABLED,
            insertbackground="#d4d4d4",
        )
        scrollbar = ttk.Scrollbar(console_frame, command=self.console.yview)
        self.console.configure(yscrollcommand=scrollbar.set)

        self.console.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)

        # Text tags for coloring
        self.console.tag_configure("info", foreground="#569cd6")
        self.console.tag_configure("success", foreground="#6a9955")
        self.console.tag_configure("error", foreground="#f44747")
        self.console.tag_configure("command", foreground="#dcdcaa")
        self.console.tag_configure("timestamp", foreground="#808080")

    def _get_available_actions(self):
        env = self.env_var.get()
        return [name for name, cfg in ACTIONS.items() if env in cfg["targets"]]

    def _on_env_change(self, event=None):
        available = self._get_available_actions()
        self.action_menu.configure(values=available)
        if self.action_var.get() not in available:
            self.action_var.set(available[0] if available else "")

    def _log(self, text, tag=None):
        """Append text to console (thread-safe via .after)."""
        def _append():
            self.console.configure(state=tk.NORMAL)
            if tag:
                self.console.insert(tk.END, text, tag)
            else:
                self.console.insert(tk.END, text)
            self.console.see(tk.END)
            self.console.configure(state=tk.DISABLED)

        self.root.after(0, _append)

    def _log_stream(self, raw_data, tag=None):
        """
        Append streaming data to console, handling:
        - ANSI escape stripping
        - Carriage return (\\r) overwrites the last line (progress bars)
        """
        clean = ANSI_ESCAPE.sub("", raw_data)

        # Normalize \r\n to \n, then handle standalone \r
        clean = clean.replace("\r\n", "\n")

        def _append():
            self.console.configure(state=tk.NORMAL)

            # Process character by character logic for \r
            # Split on \n first to get real lines
            lines = clean.split("\n")

            for line_idx, line in enumerate(lines):
                if line_idx > 0:
                    # This came after a \n, so start a new line
                    self.console.insert(tk.END, "\n")

                if "\r" in line:
                    # Multiple \r-separated segments: only show the last one
                    # (earlier segments were "overwritten" by later ones)
                    segments = line.split("\r")
                    final = segments[-1]
                    if final:
                        if tag:
                            self.console.insert(tk.END, final, tag)
                        else:
                            self.console.insert(tk.END, final)
                else:
                    if line:
                        if tag:
                            self.console.insert(tk.END, line, tag)
                        else:
                            self.console.insert(tk.END, line)

            self.console.see(tk.END)
            self.console.configure(state=tk.DISABLED)

        self.root.after(0, _append)

    def _log_header(self, text):
        ts = datetime.now().strftime("%H:%M:%S")
        self._log(f"[{ts}] ", "timestamp")
        self._log(f"{text}\n", "info")

    def _log_cmd(self, cmd):
        self._log(f"$ {cmd}\n", "command")

    def _set_status(self, text, color="gray"):
        def _update():
            self.status_var.set(text)
            self.status_label.configure(foreground=color)

        self.root.after(0, _update)

    def _set_running(self, running):
        self.running = running

        def _update():
            if running:
                self.run_btn.configure(state=tk.DISABLED)
                self.stop_btn.configure(state=tk.NORMAL)
            else:
                self.run_btn.configure(state=tk.NORMAL)
                self.stop_btn.configure(state=tk.DISABLED)

        self.root.after(0, _update)

    def _clear_output(self):
        self.console.configure(state=tk.NORMAL)
        self.console.delete("1.0", tk.END)
        self.console.configure(state=tk.DISABLED)

    def _run_action(self):
        env_key = self.env_var.get()
        action_name = self.action_var.get()

        if not env_key or not action_name:
            messagebox.showwarning("Missing selection", "Select an environment and action.")
            return

        action = ACTIONS[action_name]
        env = ENVIRONMENTS[env_key]

        self._set_running(True)
        self._log_header(f"Running '{action_name}' on {env['label']} ({env['host']})")

        if action.get("special") == "proxy_update":
            self.current_thread = threading.Thread(
                target=self._run_proxy_update, args=(env,), daemon=True
            )
        elif action.get("special") == "stream_logs":
            self.current_thread = threading.Thread(
                target=self._run_stream_command,
                args=(env, action["command"]),
                daemon=True,
            )
        elif action.get("special") == "db_shell":
            self.current_thread = threading.Thread(
                target=self._run_db_shell, args=(env,), daemon=True
            )
        else:
            self.current_thread = threading.Thread(
                target=self._run_ssh_commands,
                args=(env, action["commands"]),
                daemon=True,
            )
        self.current_thread.start()

    def _stop_action(self):
        self.running = False
        self._set_status("Stopping...", "orange")

    def _get_ssh_client(self, env):
        """Create and connect an SSH client using local keys."""
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        client.connect(
            hostname=env["host"],
            username=env["user"],
            look_for_keys=True,
            allow_agent=True,
            timeout=10,
        )
        return client

    def _run_ssh_commands(self, env, commands):
        """Execute a list of commands over SSH, streaming output."""
        try:
            self._set_status(f"Connecting to {env['host']}...", "orange")
            client = self._get_ssh_client(env)
            self._set_status(f"Connected to {env['host']}", "green")

            for cmd in commands:
                if not self.running:
                    self._log("\n⚠ Stopped by user.\n", "error")
                    break

                self._log_cmd(cmd)
                stdin, stdout, stderr = client.exec_command(cmd, get_pty=True)

                # Stream stdout
                for line in iter(stdout.readline, ""):
                    if not self.running:
                        break
                    self._log_stream(line)

                # Capture stderr
                err = stderr.read().decode()
                if err.strip():
                    self._log_stream(err, "error")

                exit_code = stdout.channel.recv_exit_status()
                if exit_code != 0:
                    self._log(f"\n✗ Command exited with code {exit_code}\n", "error")
                    self._set_status("Failed", "red")
                    break
                else:
                    self._log(f"✓ Done\n", "success")

            else:
                self._log("\n✓ All commands completed successfully.\n", "success")
                self._set_status("Done", "green")

            client.close()

        except Exception as e:
            self._log(f"\n✗ Error: {e}\n", "error")
            self._set_status("Error", "red")
        finally:
            self._set_running(False)

    def _run_proxy_update(self, env):
        """Handle proxy config update: SCP files then reload nginx."""
        try:
            self._set_status("Uploading config files...", "orange")

            nginx_src = os.path.join(REPO_ROOT, "deploy", "nginx", "nginx.conf")
            host = env["host"]
            user = env["user"]

            # SCP nginx.conf
            self._log_cmd(
                f"scp {nginx_src} {user}@{host}:/etc/nginx/sites-available/eurobureau.conf"
            )
            client = self._get_ssh_client(env)
            sftp = client.open_sftp()

            sftp.put(nginx_src, "/etc/nginx/sites-available/eurobureau.conf")
            self._log("✓ Uploaded nginx.conf\n", "success")

            sftp.close()

            # Test and reload nginx
            if self.running:
                self._log_cmd("nginx -t && nginx -s reload")
                stdin, stdout, stderr = client.exec_command(
                    "nginx -t && nginx -s reload", get_pty=True
                )
                for line in iter(stdout.readline, ""):
                    self._log_stream(line)
                err = stderr.read().decode()
                if err.strip():
                    self._log_stream(err, "error")

                exit_code = stdout.channel.recv_exit_status()
                if exit_code == 0:
                    self._log("\n✓ Nginx reloaded successfully.\n", "success")
                    self._set_status("Done", "green")
                else:
                    self._log(f"\n✗ Nginx reload failed (code {exit_code})\n", "error")
                    self._set_status("Failed", "red")

            client.close()

        except Exception as e:
            self._log(f"\n✗ Error: {e}\n", "error")
            self._set_status("Error", "red")
        finally:
            self._set_running(False)

    def _run_stream_command(self, env, command):
        """Run a long-lived streaming command (like log tailing). Stops on user cancel."""
        try:
            self._set_status(f"Connecting to {env['host']}...", "orange")
            client = self._get_ssh_client(env)
            self._set_status(f"Streaming logs from {env['host']}...", "green")

            self._log_cmd(command)
            transport = client.get_transport()
            channel = transport.open_session()
            channel.get_pty()
            channel.exec_command(command)

            # Read output in a loop until stopped
            while self.running:
                if channel.recv_ready():
                    data = channel.recv(4096).decode("utf-8", errors="replace")
                    if data:
                        self._log_stream(data)
                elif channel.exit_status_ready():
                    # Command ended on its own
                    break
                else:
                    # Small sleep to avoid busy-waiting
                    import time
                    time.sleep(0.1)

            # Drain any remaining output
            while channel.recv_ready():
                data = channel.recv(4096).decode("utf-8", errors="replace")
                if data:
                    self._log_stream(data)

            channel.close()
            client.close()

            if not self.running:
                self._log("\n⚠ Stream stopped by user.\n", "info")
            self._set_status("Done", "green")

        except Exception as e:
            self._log(f"\n✗ Error: {e}\n", "error")
            self._set_status("Error", "red")
        finally:
            self._set_running(False)

    def _run_db_shell(self, env):
        """Open an interactive psql session via SSH in an external terminal."""
        try:
            host = env["host"]
            user = env["user"]
            cmd = f"ssh -t {user}@{host} 'cd /opt/euro-office/repo/deploy && docker compose exec postgres psql -U portal portal'"

            self._log_header(f"Opening database shell on {env['label']}")
            self._log_cmd(cmd)
            self._log("Launching in external terminal...\n", "info")

            # Try various terminal emulators
            terminals = [
                ["x-terminal-emulator", "-e"],
                ["gnome-terminal", "--"],
                ["konsole", "-e"],
                ["xfce4-terminal", "-e"],
                ["xterm", "-e"],
            ]

            launched = False
            for term_cmd in terminals:
                try:
                    subprocess.Popen(term_cmd + ["bash", "-c", cmd])
                    launched = True
                    self._log(f"✓ Opened in {term_cmd[0]}\n", "success")
                    break
                except FileNotFoundError:
                    continue

            if not launched:
                # Fallback: just tell the user the command
                self._log("Could not find a terminal emulator. Run manually:\n", "error")
                self._log(f"  {cmd}\n", "command")

            self._set_status("Done", "green")

        except Exception as e:
            self._log(f"\n✗ Error: {e}\n", "error")
            self._set_status("Error", "red")
        finally:
            self._set_running(False)


def main():
    root = tk.Tk()
    app = DeployHelper(root)
    root.mainloop()


if __name__ == "__main__":
    main()
