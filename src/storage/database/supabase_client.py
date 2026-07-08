import os
from typing import Optional

import httpx
from supabase import create_client, Client, ClientOptions

_env_loaded = False


def _load_env() -> None:
    global _env_loaded

    if _env_loaded or (os.getenv("COZE_SUPABASE_URL") and os.getenv("COZE_SUPABASE_ANON_KEY")):
        return

    try:
        from dotenv import load_dotenv
        load_dotenv()
        if os.getenv("COZE_SUPABASE_URL") and os.getenv("COZE_SUPABASE_ANON_KEY"):
            _env_loaded = True
            return
    except ImportError:
        pass

    try:
        from coze_workload_identity import Client as WorkloadClient

        client = WorkloadClient()
        env_vars = client.get_project_env_vars()
        client.close()

        for env_var in env_vars:
            if not os.getenv(env_var.key):
                os.environ[env_var.key] = env_var.value

        _env_loaded = True
    except Exception:
        pass


def get_supabase_credentials() -> tuple[str, str]:
    _load_env()

    url = os.getenv("COZE_SUPABASE_URL")
    anon_key = os.getenv("COZE_SUPABASE_ANON_KEY")

    if not url:
        raise ValueError("COZE_SUPABASE_URL is not set")
    if not anon_key:
        raise ValueError("COZE_SUPABASE_ANON_KEY is not set")

    return url, anon_key


def get_supabase_service_role_key() -> Optional[str]:
    _load_env()
    return os.getenv("COZE_SUPABASE_SERVICE_ROLE_KEY")


def get_supabase_client(token: Optional[str] = None) -> Client:
    url, anon_key = get_supabase_credentials()

    if token:
        key = anon_key
    else:
        service_role_key = get_supabase_service_role_key()
        key = service_role_key if service_role_key else anon_key

    # http2=True is set on HTTPTransport (not httpx.Client) because we provide
    # a custom transport for report instrumentation wrapping.
    transport: httpx.BaseTransport = httpx.HTTPTransport(http2=True)
    try:
        from coze_coding_dev_sdk.report import get_report_buffer, InstrumentedTransport

        buffer = get_report_buffer()
        print(f"[report] supabase-client: buffer = {bool(buffer)}")
        if buffer:
            transport = InstrumentedTransport(transport, buffer, source="supabase")
            print("[report] supabase-client: InstrumentedTransport injected")
    except Exception as e:
        print(f"[report] supabase-client: setup failed: {e}")

    http_client = httpx.Client(
        transport=transport,
        timeout=httpx.Timeout(
            connect=20.0,
            read=60.0,
            write=60.0,
            pool=10.0,
        ),
        limits=httpx.Limits(
            max_connections=100,
            max_keepalive_connections=20,
            keepalive_expiry=30.0,
        ),
        follow_redirects=True,
    )

    if token:
        options = ClientOptions(
            httpx_client=http_client,
            headers={"Authorization": f"Bearer {token}"},
            auto_refresh_token=False,
        )
    else:
        options = ClientOptions(
            httpx_client=http_client,
            auto_refresh_token=False,
        )

    return create_client(url, key, options=options)
