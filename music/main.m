/*
 * Dongge Music - iPadOS 13 native host.
 *
 * A WKWebView hosts the original APK assets (bridge.html + plugin.js).
 * The Android JavascriptInterface ("AndroidBridge") is re-implemented by
 * shim.js -> WKScriptMessageHandler -> NSURLSession, so all five music
 * sources keep working without rewriting the obfuscated source engine.
 *
 * Also provides: app-state persistence (Documents/appstate.json) and
 * download-to-Documents with progress callbacks.
 *
 * Build with clang only; no Xcode project, no CocoaPods, iOS 13.0 target.
 */
#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreFoundation/CoreFoundation.h>
#import <math.h>

/* Encode any NSString as a safe JS string literal (including quotes). */
static NSString *DGJSQuote(NSString *s) {
    NSData *d = [NSJSONSerialization dataWithJSONObject:(s ?: @"")
                                                options:NSJSONWritingFragmentsAllowed
                                                  error:NULL];
    return d ? [[NSString alloc] initWithData:d encoding:NSUTF8StringEncoding] : @"\"\"";
}

static NSString *DGDocumentsPath(void) {
    return NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES).firstObject;
}

/* Music CDNs reject or throttle requests that arrive with no Referer.
   Match the referer to the host instead of sending one global value, which
   would break the platforms that do not expect it. */
static NSString *DGRefererForURL(NSURL *url) {
    NSString *h = (url.host ?: @"").lowercaseString;
    if ([h hasSuffix:@"126.net"] || [h hasSuffix:@"163.com"] || [h hasSuffix:@"163cn.tv"]) return @"https://music.163.com/";
    if ([h hasSuffix:@"kugou.com"] || [h hasSuffix:@"kugou.net"] || [h hasSuffix:@"kgimg.com"]) return @"https://www.kugou.com/";
    if ([h hasSuffix:@"kuwo.cn"]) return @"http://www.kuwo.cn/";
    if ([h hasSuffix:@"migu.cn"] || [h hasSuffix:@"msstatic.com"]) return @"https://music.migu.cn/";
    if ([h hasSuffix:@"qq.com"]) return @"https://y.qq.com/";
    return @"";
}

static NSString *DGMediaUA(void) {
    return @"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
}

#pragma mark - Downloader with progress

@interface DGDownloader : NSObject <NSURLSessionDownloadDelegate>
@property (nonatomic, copy) void (^onProgress)(double);
@property (nonatomic, copy) void (^onFinish)(BOOL ok, NSString *fileName);
@property (nonatomic, strong) NSString *fileName;
@property (nonatomic, strong) NSURLSession *session;
@end

@implementation DGDownloader

- (void)startWithURL:(NSURL *)url fileName:(NSString *)fileName {
    self.fileName = fileName;
    NSURLSessionConfiguration *cfg = [NSURLSessionConfiguration defaultSessionConfiguration];
    self.session = [NSURLSession sessionWithConfiguration:cfg delegate:self delegateQueue:nil];
    [[self.session downloadTaskWithURL:url] resume];
}

- (void)URLSession:(NSURLSession *)session downloadTask:(NSURLSessionDownloadTask *)task
                         didWriteData:(int64_t)bytesWritten
                    totalBytesWritten:(int64_t)totalBytesWritten
            totalBytesExpectedToWrite:(int64_t)totalBytesExpectedToWrite {
    if (totalBytesExpectedToWrite <= 0) return;
    double pct = (double)totalBytesWritten / (double)totalBytesExpectedToWrite * 100.0;
    if (self.onProgress) self.onProgress(pct);
}

- (void)URLSession:(NSURLSession *)session downloadTask:(NSURLSessionDownloadTask *)task
                         didFinishDownloadingToURL:(NSURL *)location {
    NSString *dir = [DGDocumentsPath() stringByAppendingPathComponent:@"Downloads"];
    [[NSFileManager defaultManager] createDirectoryAtPath:dir
                              withIntermediateDirectories:YES attributes:nil error:NULL];
    NSString *dest = [dir stringByAppendingPathComponent:(self.fileName ?: @"song.mp3")];
    [[NSFileManager defaultManager] removeItemAtPath:dest error:NULL];
    BOOL ok = [[NSFileManager defaultManager] moveItemAtPath:location.path toPath:dest error:NULL];
    if (self.onFinish) self.onFinish(ok, self.fileName);
}

- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task
                            didCompleteWithError:(NSError *)error {
    if (error && self.onFinish) self.onFinish(NO, self.fileName);
    [session finishTasksAndInvalidate];
}

@end

#pragma mark - View controller

@interface DGViewController : UIViewController <WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate>
@property (nonatomic, strong) WKWebView *web;
@property (nonatomic, strong) NSMutableArray *downloads;
/* Native playback. WKWebView's <audio> on iOS 13 (file:// origin, progressive
   http stream) reports a bogus duration and fires `ended` after a few seconds
   on these CDN links; AVPlayer handles Range/resume/background properly. */
@property (nonatomic, strong) AVPlayer *player;
@property (nonatomic, strong) id playerTimeObs;
@property (nonatomic, assign) float playerLastRate;
@property (nonatomic, copy) NSString *playerUrl;
@end

@implementation DGViewController

- (UIStatusBarStyle)preferredStatusBarStyle { return UIStatusBarStyleLightContent; }

- (void)viewDidLoad {
    [super viewDidLoad];
    self.downloads = [NSMutableArray array];
    self.view.backgroundColor = [UIColor colorWithRed:0.043 green:0.055 blue:0.078 alpha:1.0];

    AVAudioSession *session = [AVAudioSession sharedInstance];
    [session setCategory:AVAudioSessionCategoryPlayback error:nil];
    [session setActive:YES error:nil];
    [session setActive:YES error:nil];

    WKWebViewConfiguration *cfg = [[WKWebViewConfiguration alloc] init];
    cfg.allowsInlineMediaPlayback = YES;
    cfg.mediaTypesRequiringUserActionForPlayback = WKAudiovisualMediaTypeNone;

    WKUserContentController *ucc = [[WKUserContentController alloc] init];
    [ucc addScriptMessageHandler:self name:@"iosBridge"];
    NSURL *shimURL = [[[NSBundle mainBundle] bundleURL] URLByAppendingPathComponent:@"web/shim.js"];
    NSString *shim = [NSString stringWithContentsOfURL:shimURL encoding:NSUTF8StringEncoding error:NULL];
    if (shim.length) {
        WKUserScript *script = [[WKUserScript alloc] initWithSource:shim
                                                      injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                                   forMainFrameOnly:YES];
        [ucc addUserScript:script];
    } else {
        NSLog(@"[DG] WARNING: web/shim.js missing");
    }
    cfg.userContentController = ucc;

    WKWebView *wv = [[WKWebView alloc] initWithFrame:CGRectZero configuration:cfg];
    wv.navigationDelegate = self;
    wv.UIDelegate = self;
    wv.opaque = NO;
    wv.backgroundColor = [UIColor clearColor];
    wv.scrollView.backgroundColor = [UIColor clearColor];
    wv.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:wv];
    self.web = wv;

    [NSLayoutConstraint activateConstraints:@[
        [wv.topAnchor constraintEqualToAnchor:self.view.safeAreaLayoutGuide.topAnchor],
        [wv.bottomAnchor constraintEqualToAnchor:self.view.bottomAnchor],
        [wv.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor],
        [wv.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor]
    ]];

    NSURL *bundle = [[NSBundle mainBundle] bundleURL];
    NSURL *index = [bundle URLByAppendingPathComponent:@"web/index.html"];
    if (![[NSFileManager defaultManager] fileExistsAtPath:index.path]) {
        NSLog(@"[DG] ERROR: web/index.html missing at %@", index.path);
        return;
    }
    [wv loadFileURL:index allowingReadAccessToURL:bundle];
    NSLog(@"[DG] loading %@", index.path);
}

- (void)dealloc {
    if (_playerTimeObs) [_player removeTimeObserver:_playerTimeObs];
    [[NSNotificationCenter defaultCenter] removeObserver:self];
}

- (void)evalJS:(NSString *)js {
    if (!js.length) return;
    if ([NSThread isMainThread]) {
        [self.web evaluateJavaScript:js completionHandler:nil];
    } else {
        dispatch_async(dispatch_get_main_queue(), ^{ [self.web evaluateJavaScript:js completionHandler:nil]; });
    }
}

#pragma mark - App state

- (NSString *)statePath {
    return [DGDocumentsPath() stringByAppendingPathComponent:@"appstate.json"];
}

- (void)pushState {
    NSString *json = [NSString stringWithContentsOfFile:[self statePath]
                                              encoding:NSUTF8StringEncoding error:NULL] ?: @"{}";
    [self evalJS:[NSString stringWithFormat:@"if(window.__initStore)window.__initStore(%@);", DGJSQuote(json)]];
}

- (void)saveState:(NSString *)json {
    [(json ?: @"{}") writeToFile:[self statePath] atomically:YES encoding:NSUTF8StringEncoding error:NULL];
}

#pragma mark - WKScriptMessageHandler

- (void)userContentController:(WKUserContentController *)ucc didReceiveScriptMessage:(WKScriptMessage *)message {
    if (![message.body isKindOfClass:[NSDictionary class]]) return;
    NSDictionary *b = (NSDictionary *)message.body;
    NSString *op = b[@"op"];

    if ([op isEqualToString:@"http"])              { [self handleHTTP:b]; }
    else if ([op isEqualToString:@"result"])       { [self handleResult:b]; }
    else if ([op isEqualToString:@"download"])     { [self handleDownload:b]; }
    else if ([op isEqualToString:@"store"])        { [self saveState:b[@"json"]]; }
    else if ([op isEqualToString:@"play"])         { [self handlePlay:b]; }
    else if ([op isEqualToString:@"pause"])        { [self handlePlayerPause]; }
    else if ([op isEqualToString:@"resume"])       { [self handlePlayerResume]; }
    else if ([op isEqualToString:@"seek"])         { [self handlePlayerSeek:b]; }
    else if ([op isEqualToString:@"stop"])         { [self stopPlayer]; }
    else if ([op isEqualToString:@"loaded"])       {
        NSLog(@"[DG] source engine ready");
        [self evalJS:@"window.__dgLog&&window.__dgLog('native','engine loaded');"];
    }
    else if ([op isEqualToString:@"log"])          { NSLog(@"[DG][web] %@", b[@"msg"]); }
}

- (void)handleHTTP:(NSDictionary *)b {
    id rid = b[@"id"] ?: @0;
    NSString *urlString = b[@"url"];
    NSDictionary *opts = @{};
    if ([b[@"opts"] isKindOfClass:[NSString class]]) {
        NSData *d = [(NSString *)b[@"opts"] dataUsingEncoding:NSUTF8StringEncoding];
        id parsed = [NSJSONSerialization JSONObjectWithData:d options:0 error:NULL];
        if ([parsed isKindOfClass:[NSDictionary class]]) opts = parsed;
    }

    NSURL *url = [NSURL URLWithString:(urlString ?: @"")];
    if (!url || !url.scheme) {
        [self respond:rid ok:NO status:0 headers:@"{}" body:@"bad_url"];
        return;
    }

    NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:url];
    NSString *method = opts[@"method"];
    req.HTTPMethod = ([method isKindOfClass:[NSString class]] && [method length])
        ? [method uppercaseString] : @"GET";

    NSDictionary *headers = opts[@"headers"];
    if ([headers isKindOfClass:[NSDictionary class]]) {
        for (NSString *k in headers) {
            id v = headers[k];
            if ([k isKindOfClass:[NSString class]] && v) {
                [req setValue:[NSString stringWithFormat:@"%@", v] forHTTPHeaderField:k];
            }
        }
    }
    if (![req valueForHTTPHeaderField:@"User-Agent"]) {
        /* Must be a well-formed UA: the truncated form makes several music
           gateways answer with an HTML block page instead of JSON. */
        [req setValue:@"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
          forHTTPHeaderField:@"User-Agent"];
    }
    double timeoutMs = [opts[@"timeout"] doubleValue];
    if (timeoutMs <= 0) timeoutMs = 15000.0;
    req.timeoutInterval = timeoutMs / 1000.0;

    id bodyObj = opts[@"body"];
    if ([bodyObj isKindOfClass:[NSString class]]) {
        req.HTTPBody = [(NSString *)bodyObj dataUsingEncoding:NSUTF8StringEncoding];
    } else if ([bodyObj isKindOfClass:[NSDictionary class]] || [bodyObj isKindOfClass:[NSArray class]]) {
        req.HTTPBody = [NSJSONSerialization dataWithJSONObject:bodyObj options:0 error:NULL];
    }

    /* One shared session: the source engine fires 20-30 concurrent requests per lookup. */
    static NSURLSession *dgSession;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        NSURLSessionConfiguration *sc = [NSURLSessionConfiguration defaultSessionConfiguration];
        sc.requestCachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
        sc.HTTPMaximumConnectionsPerHost = 12;
        dgSession = [NSURLSession sessionWithConfiguration:sc];
    });

    __weak typeof(self) weakSelf = self;
    NSURLSessionDataTask *task = [dgSession dataTaskWithRequest:req
        completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
            NSInteger status = 0;
            NSDictionary *hdrs = @{};
            if ([response isKindOfClass:[NSHTTPURLResponse class]]) {
                NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;
                status = http.statusCode;
                hdrs = http.allHeaderFields ?: @{};
            }
            NSString *ct = @"";
            for (NSString *k in hdrs) {
                if ([k isKindOfClass:[NSString class]] &&
                    [k caseInsensitiveCompare:@"Content-Type"] == NSOrderedSame) {
                    ct = [NSString stringWithFormat:@"%@", hdrs[k]].lowercaseString;
                    break;
                }
            }

            /* The engine's guard turns the JS string back into bytes with
               `charCodeAt(i) & 0xFF` (Latin-1). Decoding audio as UTF-8 destroys
               every byte > 0x7F, so magic sniffing fails ("guard: unknown magic").
               Text-ish payloads keep UTF-8 (JSON must stay readable). */
            NSUInteger firstByte = 0;
            BOOL hasFirst = NO;
            if (data.length) {
                const unsigned char *p = data.bytes;
                NSUInteger i = 0;
                while (i < data.length && (p[i] == ' ' || p[i] == '\t' || p[i] == '\r' || p[i] == '\n')) i++;
                if (i < data.length) { firstByte = p[i]; hasFirst = YES; }
            }
            BOOL looksJson = (hasFirst && (firstByte == '{' || firstByte == '['));
            BOOL textish = (looksJson ||
                            [ct rangeOfString:@"json"].location != NSNotFound ||
                            [ct rangeOfString:@"text/"].location != NSNotFound ||
                            [ct rangeOfString:@"javascript"].location != NSNotFound ||
                            [ct rangeOfString:@"xml"].location != NSNotFound);

            /* A probe (Range) request only needs the header bytes. If the origin
               ignores Range and streams the whole track, keep the payload small:
               pushing megabytes through evaluateJavaScript would stall the UI. */
            NSString *reqRange = [req valueForHTTPHeaderField:@"Range"];
            NSData *payload = data;
            if (reqRange.length && data.length > 65536) {
                payload = [data subdataWithRange:NSMakeRange(0, 65536)];
            }

            NSString *body = @"";
            if (payload.length) {
                if (textish) {
                    body = [[NSString alloc] initWithData:payload encoding:NSUTF8StringEncoding];
                    if (!body) {
                        NSStringEncoding gbk = CFStringConvertEncodingToNSStringEncoding(kCFStringEncodingGB_18030_2000);
                        body = [[NSString alloc] initWithData:payload encoding:gbk] ?: @"";
                    }
                } else {
                    /* byte-preserving: one char per byte */
                    body = [[NSString alloc] initWithData:payload encoding:NSISOLatin1StringEncoding] ?: @"";
                }
            }
            NSString *hj = @"{}";
            NSData *hd = [NSJSONSerialization dataWithJSONObject:hdrs options:0 error:NULL];
            if (hd) hj = [[NSString alloc] initWithData:hd encoding:NSUTF8StringEncoding] ?: @"{}";

            /* An HTML/XML page is never a usable payload for this app: the engine's
               guard aborts the whole channel chain on it. Decide on the raw first
               byte, so binary bodies are judged without any decoding involved. */
            BOOL htmlType = (ct.length > 0 && [ct rangeOfString:@"html"].location != NSNotFound);
            BOOL looksMarkup = (htmlType || (hasFirst && firstByte == '<'));

            if (error || status >= 400 || status == 0) {
                NSString *m = [NSString stringWithFormat:@"http %ld %@ %@",
                               (long)status, url.host ?: @"",
                               error ? [NSString stringWithFormat:@"%@(%ld)", error.localizedDescription, (long)error.code] : @"-"];
                [weakSelf evalJS:[NSString stringWithFormat:@"window.__dgLog&&window.__dgLog('net',%@);",
                                  DGJSQuote(m)]];
            } else if (looksMarkup) {
                NSString *m = [NSString stringWithFormat:@"html %ld %@%@ ct=%@",
                               (long)status, url.host ?: @"", url.path ?: @"", ct];
                if (m.length > 100) m = [m substringToIndex:100];
                [weakSelf evalJS:[NSString stringWithFormat:@"window.__dgLog&&window.__dgLog('net',%@);",
                                  DGJSQuote(m)]];
            }

            /* Compact trace of the responses that matter: the engine's 64-byte
               Range probes (what the payload guard actually inspects) and any
               failure. Normal JSON calls stay silent so the log stays readable. */
            BOOL interesting = (reqRange.length > 0 || error || status < 200 || status >= 400 || looksMarkup);
            if (interesting) {
                NSString *b0 = hasFirst ? [NSString stringWithFormat:@"%02X", (unsigned)firstByte] : @"-";
                NSString *trace = [NSString stringWithFormat:@"%@%ld %@%@ ct=%@ b0=%@ n=%lu",
                                   (reqRange.length ? @"R " : @""), (long)status,
                                   url.host ?: @"", url.path ?: @"", ct, b0,
                                   (unsigned long)data.length];
                if (trace.length > 110) trace = [trace substringToIndex:110];
                [weakSelf evalJS:[NSString stringWithFormat:@"window.__dgLog&&window.__dgLog('req',%@);",
                                  DGJSQuote(trace)]];
            }

            /* Only 2xx/3xx with a non-markup body count as success. Feeding an
               error page back as a normal response poisons the source engine's
               payload guard ("guard: text/html payload"), which then aborts the
               whole channel chain — including the channels that would work. */
            BOOL ok = (!error && status >= 200 && status < 400 && !looksMarkup);

            [weakSelf respond:rid ok:ok status:status headers:hj body:body];
        }];
    [task resume];
}

- (void)respond:(id)rid ok:(BOOL)ok status:(NSInteger)status headers:(NSString *)hj body:(NSString *)body {
    NSString *js = [NSString stringWithFormat:@"if(window.__resp)window.__resp(%@,%@,%ld,%@,%@);",
                    rid, ok ? @"true" : @"false", (long)status, DGJSQuote(hj), DGJSQuote(body)];
    [self evalJS:js];
}

- (void)handleResult:(NSDictionary *)b {
    NSString *js = [NSString stringWithFormat:@"if(window.__onUrl)window.__onUrl(%@,%@);",
                    DGJSQuote(b[@"id"]), DGJSQuote(b[@"url"])];
    [self evalJS:js];
}

- (void)handleDownload:(NSDictionary *)b {
    NSString *urlString = b[@"url"];
    NSURL *url = [NSURL URLWithString:(urlString ?: @"")];
    NSString *dlId = [b[@"id"] isKindOfClass:[NSString class]] ? b[@"id"] : @"";
    NSString *rawName = [b[@"name"] isKindOfClass:[NSString class]] ? b[@"name"] : @"song.mp3";
    NSString *name = [[rawName stringByReplacingOccurrencesOfString:@"/" withString:@"_"]
                        stringByReplacingOccurrencesOfString:@":" withString:@"_"];

    if (!url || !url.scheme) {
        [self finishDownload:dlId ok:NO name:name];
        return;
    }

    DGDownloader *dl = [[DGDownloader alloc] init];
    __weak typeof(self) weakSelf = self;
    dl.onProgress = ^(double pct) {
        [weakSelf evalJS:[NSString stringWithFormat:@"if(window.__onProgress)window.__onProgress(%@,%f);",
                          DGJSQuote(dlId), pct]];
    };
    dl.onFinish = ^(BOOL ok, NSString *fileName) {
        [weakSelf finishDownload:dlId ok:ok name:fileName];
        [weakSelf.downloads removeObject:dl];
    };
    [self.downloads addObject:dl];   /* keep alive until the task finishes */
    [dl startWithURL:url fileName:name];
}

- (void)finishDownload:(NSString *)dlId ok:(BOOL)ok name:(NSString *)name {
    [self evalJS:[NSString stringWithFormat:@"if(window.__onDownload)window.__onDownload(%@,%@,%@);",
                  DGJSQuote(dlId), ok ? @"true" : @"false", DGJSQuote(name)]];
}

#pragma mark - Native audio player

- (void)pushPlayerEvent:(NSDictionary *)ev {
    NSData *d = [NSJSONSerialization dataWithJSONObject:ev options:0 error:NULL];
    if (!d) return;
    NSString *json = [[NSString alloc] initWithData:d encoding:NSUTF8StringEncoding];
    if (!json.length) return;
    [self evalJS:[NSString stringWithFormat:@"if(window.__player)window.__player(%@);", json]];
}

- (void)handlePlay:(NSDictionary *)b {
    NSString *us = [b[@"url"] isKindOfClass:[NSString class]] ? b[@"url"] : @"";
    NSURL *url = [NSURL URLWithString:us];
    if (!url || !url.scheme) {
        [self pushPlayerEvent:@{@"ev": @"error", @"msg": @"bad_url"}];
        return;
    }

    [self stopPlayer];

    NSMutableDictionary *assetOpts = [NSMutableDictionary dictionary];
    NSMutableDictionary *hdr = [NSMutableDictionary dictionary];
    hdr[@"User-Agent"] = DGMediaUA();
    NSString *referer = DGRefererForURL(url);
    if (referer.length) hdr[@"Referer"] = referer;
    assetOpts[@"AVURLAssetHTTPHeaderFieldsKey"] = hdr;

    AVURLAsset *asset = [AVURLAsset URLAssetWithURL:url options:assetOpts];
    AVPlayerItem *item = [AVPlayerItem playerItemWithAsset:asset];
    self.player = [AVPlayer playerWithPlayerItem:item];
    self.player.automaticallyWaitsToMinimizeStalling = YES;
    self.playerUrl = us;
    self.playerLastRate = 0.0f;

    [[AVAudioSession sharedInstance] setCategory:AVAudioSessionCategoryPlayback error:nil];
    [[AVAudioSession sharedInstance] setActive:YES error:nil];

    NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
    [nc addObserver:self selector:@selector(onItemEnded:) name:AVPlayerItemDidPlayToEndTimeNotification object:item];
    [nc addObserver:self selector:@selector(onItemFailed:) name:AVPlayerItemFailedToPlayToEndTimeNotification object:item];
    [nc addObserver:self selector:@selector(onItemStalled:) name:AVPlayerItemPlaybackStalledNotification object:item];

    __weak typeof(self) weakSelf = self;
    self.playerTimeObs = [self.player addPeriodicTimeObserverForInterval:CMTimeMakeWithSeconds(0.5, 600)
                                                                   queue:dispatch_get_main_queue()
                                                              usingBlock:^(CMTime t) { [weakSelf playerTick]; }];

    [self.player play];
    [self pushPlayerEvent:@{@"ev": @"loadstart", @"url": us, @"referer": referer ?: @""}];
}

- (void)playerTick {
    AVPlayerItem *item = self.player.currentItem;
    if (!item) return;

    double t = CMTimeGetSeconds(self.player.currentTime);
    if (!isfinite(t) || t < 0) t = 0;
    double dur = CMTimeGetSeconds(item.duration);
    if (!isfinite(dur) || dur < 0) dur = 0;
    double buf = 0;
    NSArray *ranges = item.loadedTimeRanges;
    if (ranges.count) {
        CMTimeRange r = [[ranges lastObject] CMTimeRangeValue];
        double e = CMTimeGetSeconds(CMTimeRangeGetEnd(r));
        if (isfinite(e) && e > 0) buf = e;
    }

    NSMutableDictionary *ev = [NSMutableDictionary dictionary];
    ev[@"ev"] = @"time";
    ev[@"t"] = @(t);
    ev[@"dur"] = @(dur);
    ev[@"buf"] = @(buf);
    ev[@"st"] = @((long)item.status);
    if (item.status == AVPlayerItemStatusFailed) {
        NSError *e = item.error;
        ev[@"err"] = e.localizedDescription ?: @"item failed";
        ev[@"code"] = @((long)e.code);
    }
    [self pushPlayerEvent:ev];

    float rate = self.player.rate;
    if ((rate > 0.01f) != (self.playerLastRate > 0.01f)) {
        self.playerLastRate = rate;
        [self pushPlayerEvent:@{@"ev": rate > 0.01f ? @"playing" : @"paused"}];
    }
}

- (void)onItemEnded:(NSNotification *)n   { [self pushPlayerEvent:@{@"ev": @"ended"}]; }
- (void)onItemStalled:(NSNotification *)n { [self pushPlayerEvent:@{@"ev": @"stalled"}]; }

- (void)onItemFailed:(NSNotification *)n {
    NSError *e = n.userInfo[AVPlayerItemFailedToPlayToEndTimeErrorKey];
    [self pushPlayerEvent:@{@"ev": @"error",
                            @"msg": e.localizedDescription ?: @"failed to play to end",
                            @"code": @((long)e.code)}];
}

- (void)handlePlayerPause  { [self.player pause]; }
- (void)handlePlayerResume {
    if (!self.player) return;
    [[AVAudioSession sharedInstance] setActive:YES error:nil];
    [self.player play];
}

- (void)handlePlayerSeek:(NSDictionary *)b {
    if (!self.player) return;
    double t = [b[@"t"] doubleValue];
    if (!isfinite(t) || t < 0) t = 0;
    [self.player seekToTime:CMTimeMakeWithSeconds(t, 600)
            toleranceBefore:kCMTimeZero
               toleranceAfter:kCMTimeZero];
}

- (void)stopPlayer {
    if (self.playerTimeObs) {
        [self.player removeTimeObserver:self.playerTimeObs];
        self.playerTimeObs = nil;
    }
    [[NSNotificationCenter defaultCenter] removeObserver:self];
    [self.player pause];
    self.player = nil;
    self.playerUrl = nil;
    self.playerLastRate = 0.0f;
}

#pragma mark - WKNavigationDelegate / WKUIDelegate

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    [self pushState];
    [self evalJS:@"if(window.__onHostReady)window.__onHostReady();"];
}

- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    NSLog(@"[DG] navigation failed: %@", error.localizedDescription);
}

- (void)webView:(WKWebView *)webView
runJavaScriptAlertPanelWithMessage:(NSString *)message
initiatedByFrame:(WKFrameInfo *)frame
completionHandler:(void (^)(void))completionHandler {
    UIAlertController *ac = [UIAlertController alertControllerWithTitle:nil
                                                               message:message
                                                        preferredStyle:UIAlertControllerStyleAlert];
    [ac addAction:[UIAlertAction actionWithTitle:@"OK" style:UIAlertActionStyleDefault
                                          handler:^(UIAlertAction *a) { completionHandler(); }]];
    [self presentViewController:ac animated:YES completion:nil];
}

- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action
decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    decisionHandler(WKNavigationActionPolicyAllow);
}

@end

#pragma mark - App delegate

@interface DGAppDelegate : UIResponder <UIApplicationDelegate>
@property (nonatomic, strong) UIWindow *window;
@end

@implementation DGAppDelegate
- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
    self.window = [[UIWindow alloc] initWithFrame:[UIScreen mainScreen].bounds];
    self.window.backgroundColor = [UIColor blackColor];
    self.window.rootViewController = [[DGViewController alloc] init];
    [self.window makeKeyAndVisible];
    return YES;
}
@end

int main(int argc, char *argv[]) {
    @autoreleasepool {
        return UIApplicationMain(argc, argv, nil, NSStringFromClass([DGAppDelegate class]));
    }
}
