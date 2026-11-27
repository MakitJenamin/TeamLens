//! Task Scheduler "At log on" cho daemon của TeamLens (task M3.8, SPEC 4.2), gọi qua COM
//! (`ITaskService`). Task thuộc chính user hiện tại, chạy với quyền thường (`LeastPrivilege`),
//! **không cần quyền admin**.
//!
//! Task chạy `conhost.exe --headless "<tl.exe>" daemon --background`: `tl.exe` là ứng dụng
//! console, `conhost --headless` cho nó chạy mà không hiện cửa sổ.
//!
//! Test chạm Task Scheduler thật được đánh dấu `#[ignore]` (chạy tay:
//! `cargo test -p tl-platform -- --ignored`) để CI và máy người khác không bị đổi.

use windows::core::{Interface, BSTR};
use windows::Win32::Foundation::{VARIANT_BOOL, VARIANT_FALSE, VARIANT_TRUE};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::System::TaskScheduler::{
    IExecAction, ILogonTrigger, ITaskFolder, ITaskService, TaskScheduler, TASK_ACTION_EXEC,
    TASK_CREATE_OR_UPDATE, TASK_INSTANCES_IGNORE_NEW, TASK_LOGON_INTERACTIVE_TOKEN,
    TASK_RUNLEVEL_LUA, TASK_TRIGGER_LOGON,
};
use windows::Win32::System::Variant::VARIANT;

use crate::PlatformError;

/// HRESULT `HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)`: task không tồn tại.
const TASK_NOT_FOUND: i32 = 0x8007_0002_u32 as i32;
/// HRESULT `RPC_E_CHANGED_MODE`: luồng đã khởi tạo COM theo kiểu khác (dùng tiếp được).
const RPC_E_CHANGED_MODE: i32 = 0x8001_0106_u32 as i32;

const DESCRIPTION: &str =
    "TeamLens: chạy daemon thu thập session AI agent khi đăng nhập Windows (gỡ bằng `tl uninstall`).";

fn os_error(action: &str, e: windows::core::Error) -> PlatformError {
    PlatformError::Os(format!("Task Scheduler ({action}): {e}"))
}

/// Khởi tạo COM cho luồng hiện tại; nhả khi drop (chỉ khi chính ta khởi tạo).
struct ComGuard(bool);

impl ComGuard {
    fn init() -> Result<Self, PlatformError> {
        // SAFETY: gọi một lần cho mỗi guard, `CoUninitialize` tương ứng nằm trong `Drop`.
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if hr.is_ok() {
            Ok(Self(true))
        } else if hr.0 == RPC_E_CHANGED_MODE {
            Ok(Self(false))
        } else {
            Err(os_error("khởi tạo COM", windows::core::Error::from(hr)))
        }
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.0 {
            // SAFETY: cặp với `CoInitializeEx` thành công ở `init`.
            unsafe { CoUninitialize() };
        }
    }
}

fn connect() -> Result<ITaskService, PlatformError> {
    // SAFETY: COM đã được khởi tạo bởi `ComGuard` của người gọi; tham số rỗng nghĩa là máy hiện tại.
    unsafe {
        let service: ITaskService = CoCreateInstance(&TaskScheduler, None, CLSCTX_INPROC_SERVER)
            .map_err(|e| os_error("tạo dịch vụ", e))?;
        service
            .Connect(
                &VARIANT::default(),
                &VARIANT::default(),
                &VARIANT::default(),
                &VARIANT::default(),
            )
            .map_err(|e| os_error("kết nối", e))?;
        Ok(service)
    }
}

fn root_folder(service: &ITaskService) -> Result<ITaskFolder, PlatformError> {
    // SAFETY: `service` đã kết nối.
    unsafe {
        service
            .GetFolder(&BSTR::from("\\"))
            .map_err(|e| os_error("mở thư mục gốc", e))
    }
}

/// `DOMAIN\user` của người đang đăng nhập (task chỉ chạy cho đúng user này).
fn current_user() -> Result<String, PlatformError> {
    let user = std::env::var("USERNAME").map_err(|_| {
        PlatformError::Os("không xác định được tên người dùng Windows (USERNAME)".into())
    })?;
    Ok(match std::env::var("USERDOMAIN") {
        Ok(domain) if !domain.trim().is_empty() => format!("{domain}\\{user}"),
        _ => user,
    })
}

fn variant_bool(value: bool) -> VARIANT_BOOL {
    if value {
        VARIANT_TRUE
    } else {
        VARIANT_FALSE
    }
}

/// Đăng ký (hoặc cập nhật) task `name` chạy `command arguments` khi user hiện tại đăng nhập.
pub(crate) fn register_task(
    name: &str,
    command: &str,
    arguments: &str,
) -> Result<(), PlatformError> {
    let user = current_user()?;
    let _com = ComGuard::init()?;
    let service = connect()?;
    let folder = root_folder(&service)?;
    let err = |what: &str| {
        let what = what.to_owned();
        move |e| os_error(&what, e)
    };
    // SAFETY: mọi interface bên dưới sinh ra từ `service` đã kết nối và còn sống trong hàm này.
    unsafe {
        let definition = service.NewTask(0).map_err(err("tạo định nghĩa"))?;

        let info = definition.RegistrationInfo().map_err(err("thông tin"))?;
        info.SetDescription(&BSTR::from(DESCRIPTION))
            .map_err(err("mô tả"))?;

        let principal = definition.Principal().map_err(err("principal"))?;
        principal
            .SetLogonType(TASK_LOGON_INTERACTIVE_TOKEN)
            .map_err(err("kiểu đăng nhập"))?;
        principal
            .SetRunLevel(TASK_RUNLEVEL_LUA)
            .map_err(err("mức quyền"))?;

        let settings = definition.Settings().map_err(err("thiết lập"))?;
        settings
            .SetEnabled(variant_bool(true))
            .map_err(err("bật task"))?;
        settings
            .SetStartWhenAvailable(variant_bool(true))
            .map_err(err("chạy bù"))?;
        settings
            .SetDisallowStartIfOnBatteries(variant_bool(false))
            .map_err(err("chạy khi dùng pin"))?;
        settings
            .SetStopIfGoingOnBatteries(variant_bool(false))
            .map_err(err("không dừng khi dùng pin"))?;
        settings
            .SetAllowDemandStart(variant_bool(true))
            .map_err(err("cho chạy tay"))?;
        settings
            .SetMultipleInstances(TASK_INSTANCES_IGNORE_NEW)
            .map_err(err("một instance"))?;
        // `PT0S`: không giới hạn thời gian chạy (daemon chạy suốt phiên đăng nhập).
        settings
            .SetExecutionTimeLimit(&BSTR::from("PT0S"))
            .map_err(err("thời gian chạy"))?;

        let triggers = definition.Triggers().map_err(err("trigger"))?;
        let trigger = triggers
            .Create(TASK_TRIGGER_LOGON)
            .map_err(err("tạo trigger"))?;
        let logon: ILogonTrigger = trigger.cast().map_err(err("trigger đăng nhập"))?;
        logon
            .SetUserId(&BSTR::from(user.as_str()))
            .map_err(err("user của trigger"))?;
        trigger
            .SetEnabled(variant_bool(true))
            .map_err(err("bật trigger"))?;

        let actions = definition.Actions().map_err(err("action"))?;
        let action = actions
            .Create(TASK_ACTION_EXEC)
            .map_err(err("tạo action"))?;
        let exec: IExecAction = action.cast().map_err(err("action chạy lệnh"))?;
        exec.SetPath(&BSTR::from(command))
            .map_err(err("đường dẫn lệnh"))?;
        exec.SetArguments(&BSTR::from(arguments))
            .map_err(err("tham số lệnh"))?;

        folder
            .RegisterTaskDefinition(
                &BSTR::from(name),
                &definition,
                TASK_CREATE_OR_UPDATE.0,
                &VARIANT::from(user.as_str()),
                &VARIANT::default(),
                TASK_LOGON_INTERACTIVE_TOKEN,
                &VARIANT::default(),
            )
            .map_err(err("đăng ký task"))?;
    }
    Ok(())
}

/// Gỡ task `name`; không lỗi nếu task không tồn tại. Đang có instance chạy (daemon) thì dừng nó
/// trước, để người gọi (`tl uninstall`) xóa được file dữ liệu mà daemon đang giữ.
pub(crate) fn unregister_task(name: &str) -> Result<(), PlatformError> {
    let _com = ComGuard::init()?;
    let service = connect()?;
    let folder = root_folder(&service)?;
    // SAFETY: `folder` thuộc `service` đã kết nối. Dừng instance là cố gắng hết sức: lỗi (task không
    // chạy, không tồn tại) bỏ qua. Biến `task` được thả trước khi thoát hàm (xem ghi chú ở `task_exists`).
    unsafe {
        if let Ok(task) = folder.GetTask(&BSTR::from(name)) {
            let _ = task.Stop(0);
            drop(task);
        }
    }
    // SAFETY: `folder` thuộc `service` đã kết nối.
    match unsafe { folder.DeleteTask(&BSTR::from(name), 0) } {
        Ok(()) => Ok(()),
        Err(e) if e.code().0 == TASK_NOT_FOUND => Ok(()),
        Err(e) => Err(os_error("gỡ task", e)),
    }
}

/// Task `name` đã đăng ký chưa.
pub(crate) fn task_exists(name: &str) -> Result<bool, PlatformError> {
    let _com = ComGuard::init()?;
    let service = connect()?;
    let folder = root_folder(&service)?;
    // SAFETY: `folder` thuộc `service` đã kết nối.
    let found = unsafe { folder.GetTask(&BSTR::from(name)) };
    match found {
        // Thả `IRegisteredTask` ngay tại đây: để nó là biến tạm ở biểu thức cuối hàm thì nó bị
        // giải phóng SAU `ComGuard` (đã `CoUninitialize`) và gây `STATUS_ACCESS_VIOLATION`.
        Ok(task) => {
            drop(task);
            Ok(true)
        }
        Err(e) if e.code().0 == TASK_NOT_FOUND => Ok(false),
        Err(e) => Err(os_error("tìm task", e)),
    }
}

/// Chạy task `name` ngay (không đợi lần đăng nhập sau).
pub(crate) fn run_task(name: &str) -> Result<(), PlatformError> {
    let _com = ComGuard::init()?;
    let service = connect()?;
    let folder = root_folder(&service)?;
    // SAFETY: `folder` thuộc `service` đã kết nối.
    unsafe {
        let task = folder
            .GetTask(&BSTR::from(name))
            .map_err(|e| os_error("tìm task", e))?;
        task.Run(&VARIANT::default())
            .map_err(|e| os_error("chạy task", e))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Chạm Task Scheduler thật của máy: chỉ chạy tay (`cargo test -p tl-platform -- --ignored`).
    #[test]
    #[ignore = "đăng ký task thật trên máy; chạy tay"]
    fn dang_ky_chay_va_go_task_that() {
        let name = format!("TeamLens-test-{}", std::process::id());
        // Phòng trường hợp lần chạy trước bỏ dở.
        unregister_task(&name).unwrap();
        assert!(!task_exists(&name).unwrap());

        register_task(&name, "cmd.exe", "/c exit 0").unwrap();
        assert!(task_exists(&name).unwrap(), "đăng ký xong phải thấy task");
        // Đăng ký lại (cập nhật) không lỗi.
        register_task(&name, "cmd.exe", "/c exit 0").unwrap();
        run_task(&name).unwrap();

        unregister_task(&name).unwrap();
        assert!(!task_exists(&name).unwrap(), "gỡ xong không còn task");
        // Gỡ lần nữa không lỗi.
        unregister_task(&name).unwrap();
    }
}
