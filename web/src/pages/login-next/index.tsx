import SvgIcon from '@/components/svg-icon';
import { useAuth } from '@/hooks/auth-hooks';
import {
  useLogin,
  useLoginChannels,
  useLoginWithChannel,
  useRegister,
} from '@/hooks/use-login-request';
import { useSystemConfig } from '@/hooks/use-system-request';
import { rsaPsw } from '@/utils';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { Button, ButtonLoading } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, UseFormReturn } from 'react-hook-form';
import { z } from 'zod';
import { NICKNAME_PATTERN } from '../user-setting/profile/constants';
import { ArrowUpRight, TrainFront } from 'lucide-react';

type LoginFormContentProps = {
  title: string;
  form: UseFormReturn<any>;
  loading: boolean;
  onCheck: (params: any) => Promise<void>;
  changeTitle: () => void;
  registerEnabled: boolean;
  channels: { channel: string; icon?: string; display_name: string }[];
  handleLoginWithChannel: (channel: string) => void;
  t: ReturnType<typeof useTranslation>['t'];
  disablePasswordLogin?: boolean;
};

function LoginFormContent({
  title,
  form,
  loading,
  onCheck,
  changeTitle,
  registerEnabled,
  channels,
  handleLoginWithChannel,
  t,
  disablePasswordLogin,
}: LoginFormContentProps) {
  const handleChannelClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    const channel = event.currentTarget.dataset.channel;
    if (channel) handleLoginWithChannel(channel);
  };

  return (
    <div className="rail-auth-form">
      <div className="rail-auth-form-heading">
        <p className="rail-eyebrow">
          {title === 'login' ? '01 / SIGN IN' : '02 / CREATE ACCOUNT'}
        </p>
        <h2>
          {title === 'login' ? t('loginTitle') : t('signUpTitle')}
        </h2>
      </div>
      <div className="w-full">
        {!disablePasswordLogin && (
          <Form {...form}>
            <form
              className="flex flex-col gap-6 text-text-primary"
              data-testid="auth-form"
              data-active="true"
              onSubmit={form.handleSubmit(onCheck)}
            >
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>{t('emailLabel')}</FormLabel>
                    <FormControl>
                      <Input
                        data-testid="auth-email"
                        placeholder={t('emailPlaceholder')}
                        autoComplete="email"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {title === 'register' && (
                <FormField
                  control={form.control}
                  name="nickname"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel required>{t('nicknameLabel')}</FormLabel>
                      <FormControl>
                        <Input
                          data-testid="auth-nickname"
                          placeholder={t('nicknamePlaceholder')}
                          autoComplete="username"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>{t('passwordLabel')}</FormLabel>
                    <FormControl>
                      <div className="relative">
                        <Input
                          data-testid="auth-password"
                          type={'password'}
                          placeholder={t('passwordPlaceholder')}
                          autoComplete={
                            title === 'login'
                              ? 'current-password'
                              : 'new-password'
                          }
                          {...field}
                        />
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {title === 'login' && (
                <FormField
                  control={form.control}
                  name="remember"
                  render={({ field }) => (
                    <FormItem>
                      <div className="flex gap-2 group">
                        <FormControl>
                          <Checkbox
                            checked={field.value}
                            onCheckedChange={field.onChange}
                            className="group-hover:border-border-default group-hover:bg-border-button"
                          />
                        </FormControl>
                        <FormLabel
                          className={cn('cursor-pointer', {
                            'text-text-disabled': !field.value,
                            'text-text-primary': field.value,
                          })}
                        >
                          {t('rememberMe')}
                        </FormLabel>
                      </div>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
              <ButtonLoading
                variant="accent"
                data-testid="auth-submit"
                type="submit"
                loading={loading}
                className="rail-auth-submit w-full"
              >
                {title === 'login' ? t('login') : t('continue')}
                <ArrowUpRight className="size-4" />
              </ButtonLoading>
            </form>
          </Form>
        )}

        {title === 'login' && channels && channels.length > 0 && (
          <div className="rail-auth-channels">
            {channels.map((item) => (
              <Button
                variant={'transparent'}
                key={item.channel}
                data-channel={item.channel}
                onClick={handleChannelClick}
                className="w-full justify-start"
              >
                <div className="flex items-center">
                  <SvgIcon
                    name={item.icon || 'sso'}
                    width={20}
                    height={20}
                    style={{ marginRight: 5 }}
                  />
                  Sign in with {item.display_name}
                </div>
              </Button>
            ))}
          </div>
        )}

        {!disablePasswordLogin && title === 'login' && registerEnabled && (
          <div className="mt-8 text-left">
            <p className="text-text-disabled text-sm">
              {t('signInTip')}
              <Button
                data-testid="auth-toggle-register"
                variant={'transparent'}
                onClick={changeTitle}
                className="text-accent-primary/90 hover:text-accent-primary hover:bg-transparent font-medium border-none transition-colors duration-200"
              >
                {t('signUp')}
              </Button>
            </p>
          </div>
        )}
        {!disablePasswordLogin && title === 'register' && (
          <div className="mt-8 text-left">
            <p className="text-text-disabled text-sm">
              {t('signUpTip')}
              <Button
                data-testid="auth-toggle-login"
                variant={'transparent'}
                onClick={changeTitle}
                className="text-accent-primary/90 hover:text-accent-primary hover:bg-transparent font-medium border-none transition-colors duration-200"
              >
                {t('login')}
              </Button>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

const Login = () => {
  const [title, setTitle] = useState('login');
  const navigate = useNavigate();
  const { login, loading: signLoading } = useLogin();
  const { register, loading: registerLoading } = useRegister();
  const { channels, loading: channelsLoading } = useLoginChannels();
  const { login: loginWithChannel, loading: loginWithChannelLoading } =
    useLoginWithChannel();
  const { t } = useTranslation('translation', { keyPrefix: 'login' });
  const { t: tSetting } = useTranslation('translation', {
    keyPrefix: 'setting',
  });

  const loading =
    signLoading ||
    registerLoading ||
    channelsLoading ||
    loginWithChannelLoading;
  const { config } = useSystemConfig();
  const registerEnabled =
    config?.registerEnabled === 1 || config?.registerEnabled === true;

  const { isLogin } = useAuth();
  useEffect(() => {
    if (isLogin) {
      navigate('/');
    }
  }, [isLogin, navigate]);

  const handleLoginWithChannel = async (channel: string) => {
    await loginWithChannel(channel);
  };

  const changeTitle = () => {
    if (title === 'login' && !registerEnabled) {
      return;
    }

    setTitle(title === 'login' ? 'register' : 'login');
  };

  const FormSchema = z
    .object({
      nickname: z.string().optional(),
      email: z
        .string()
        .email()
        .min(1, { message: t('emailPlaceholder') }),
      password: z.string().min(1, { message: t('passwordPlaceholder') }),
      remember: z.boolean().optional(),
    })
    .superRefine((data, ctx) => {
      if (title !== 'register') return;
      if (!data.nickname) {
        ctx.addIssue({
          path: ['nickname'],
          message: 'nicknamePlaceholder',
          code: z.ZodIssueCode.custom,
        });
        return;
      }
      if (!NICKNAME_PATTERN.test(data.nickname)) {
        ctx.addIssue({
          path: ['nickname'],
          message: tSetting('usernameInvalidCharacters'),
          code: z.ZodIssueCode.custom,
        });
      }
    });
  type FormValues = z.infer<typeof FormSchema>;
  const form = useForm<FormValues>({
    defaultValues: {
      nickname: '',
      email: '',
      password: '',
      remember: false,
    },
    resolver: zodResolver(FormSchema),
  });

  const onCheck = async (params: FormValues) => {
    try {
      const rsaPassWord = rsaPsw(params.password) as string;

      if (title === 'login') {
        const code = await login({
          email: `${params.email}`.trim(),
          password: rsaPassWord,
        });
        if (code === 0) {
          navigate('/');
        }
      } else {
        if (!params.nickname) return;
        const code = await register({
          nickname: params.nickname,
          email: params.email,
          password: rsaPassWord,
        });
        if (code === 0) {
          setTitle('login');
        }
      }
    } catch (errorInfo) {
      console.error('Failed:', errorInfo);
    }
  };

  return (
      <main className="rail-auth">
        <header className="rail-auth-nav">
          <span className="rail-auth-brand">
            <TrainFront className="size-5" />
            轨知 <span>RailMind</span>
          </span>
          <span className="rail-auth-nav-caption">铁路知识与故障分析辅助</span>
        </header>
        <div className="rail-auth-body">
          <div className="rail-auth-heading">
            <p className="rail-eyebrow">
              <i className="rail-status-dot" aria-hidden />
              RAILMIND <span>/</span> 铁路智能工作空间
            </p>
            <h1>
              轨知 RailMind
              <span>让知识，有据可循。</span>
            </h1>
            <p className="rail-auth-description">
              连接规章、资料与现场问题。
              <br />
              从一个问题开始，找到有依据的答案。
            </p>
            <div className="rail-auth-index" aria-hidden>
              <span>01 <b>知识检索</b></span>
              <span>02 <b>铁路问答</b></span>
              <span>03 <b>故障分析</b></span>
            </div>
          </div>
          <LoginFormContent
            title={title}
            form={form}
            loading={loading}
            onCheck={onCheck}
            changeTitle={changeTitle}
            registerEnabled={registerEnabled}
            channels={channels || []}
            handleLoginWithChannel={handleLoginWithChannel}
            t={t}
            disablePasswordLogin={!!config?.disablePasswordLogin}
          />
        </div>
        <footer className="rail-auth-footer">
          <span>轨知 RAILMIND</span>
          <span>知识可追溯 · 作业以有效规程为准</span>
        </footer>
      </main>
  );
};

export default Login;
