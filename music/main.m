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
    else if ([op isEqualToString:@"loaded"])       { NSLog(@"[DG] source engine ready"); }
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
        [req setValue:@"Mozilla/5.0 (iPad; CPU OS 13_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)"
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
            NSString *body = @"";
            if (data.length) {
                body = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
                if (!body) {
                    NSStringEncoding gbk = CFStringConvertEncodingToNSStringEncoding(kCFStringEncodingGB_18030_2000);
                    body = [[NSString alloc] initWithData:data encoding:gbk] ?: @"";
                }
            }
            NSString *hj = @"{}";
            NSData *hd = [NSJSONSerialization dataWithJSONObject:hdrs options:0 error:NULL];
            if (hd) hj = [[NSString alloc] initWithData:hd encoding:NSUTF8StringEncoding] ?: @"{}";

            [weakSelf respond:rid ok:(!error && status > 0) status:status headers:hj body:body];
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
