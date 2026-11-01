import { Eye, EyeOff } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useState, type ReactElement } from "react";
import { z } from "zod";
import { navigate } from "../lib/router.js";
import { useSession } from "../session.js";
import { Button, Field } from "../components/ui.js";

const inputClass =
  "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-[var(--tpirs-color-primary)] focus:outline-none";

const loginSchema = z.object({
  tenantSlug: z.string().min(1, "Tenant slug is required"),
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

type LoginForm = z.infer<typeof loginSchema>;

/** Step 1: staff sign-in. Sends credentials once; code + password never cached. */
export function LoginPage(): ReactElement {
  const [submitting, setSubmitting] = useState(false);
  // Typing a long password on a keyboard you do not trust is a real source of
  // failed sign-ins; showing it is the fix, and it never leaves the tab.
  const [showPassword, setShowPassword] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginForm>({ resolver: zodResolver(loginSchema) });

  const onSubmit = (values: LoginForm): void => {
    void (async () => {
      setSubmitting(true);
      try {
        await useSession.getState().login({
          tenantSlug: values.tenantSlug,
          username: values.username,
          password: values.password,
        });
        navigate("/registry");
      } catch {
        // Toast host surfaces the error envelope (message + request id).
      } finally {
        setSubmitting(false);
      }
    })();
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center px-4">
      <h1 className="mb-6 text-xl font-semibold text-slate-900">Staff sign-in</h1>
      <form
        className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
        onSubmit={(event) => {
          void handleSubmit(onSubmit)(event);
        }}
      >
        <Field
          label="Tenant slug"
          {...(errors.tenantSlug?.message === undefined
            ? {}
            : { error: errors.tenantSlug.message })}
        >
          <input
            className={inputClass}
            {...register("tenantSlug")}
            autoComplete="off"
            placeholder="example-state"
          />
        </Field>
        <Field
          label="Username"
          {...(errors.username?.message === undefined ? {} : { error: errors.username.message })}
        >
          <input className={inputClass} {...register("username")} autoComplete="username" />
        </Field>
        <Field
          label="Password"
          {...(errors.password?.message === undefined ? {} : { error: errors.password.message })}
        >
          <div className="relative">
            <input
              className={`${inputClass} pr-10`}
              {...register("password")}
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
            />
            <button
              type="button"
              onClick={() => {
                setShowPassword((current) => !current);
              }}
              aria-pressed={showPassword}
              aria-label={showPassword ? "Hide password" : "Show password"}
              className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-slate-500 hover:text-slate-900"
            >
              {showPassword ? (
                <EyeOff size={16} aria-hidden="true" />
              ) : (
                <Eye size={16} aria-hidden="true" />
              )}
            </button>
          </div>
        </Field>
        <Button type="submit" disabled={submitting}>
          {submitting ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </main>
  );
}
