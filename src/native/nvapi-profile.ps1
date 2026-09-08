param([ValidateSet('execute','selftest')][string]$Action = 'execute')
$ErrorActionPreference = 'Stop'
# DRS interop structure follows the public Manager helper in
# ../nr-manager-dxgi-options-20260908/src/product/nvapi-drs.ps1. The added
# interface IDs are pinned to NVIDIA/nvapi@87dca625 (nvapi_interface.h), and
# the ABI layouts/settings are pinned to the matching local upstream headers.
# No SDK library or runtime binary is copied or loaded outside System32.
$source = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

namespace ZhuangjizhaiNvapiProfile {
  public sealed class ProfileState { public string name { get; set; } public string appName { get; set; } public bool exclusive { get; set; } public bool owned { get; set; } }
  public sealed class SettingState { public string kind { get; set; } public uint? value { get; set; } public int? location { get; set; } public bool? predefined { get; set; } }
  public sealed class Snapshot { public ProfileState profile { get; set; } public Dictionary<string, SettingState> settings { get; set; } }
  public sealed class Request { public string op { get; set; } public string exe { get; set; } public uint[] ids { get; set; } public Snapshot expectedSnapshot { get; set; } public Snapshot desiredSnapshot { get; set; } }
  public sealed class Response { public bool ok { get; set; } public string code { get; set; } public string error { get; set; } public Snapshot snapshot { get; set; } public string layout { get; set; } }
  public sealed class AdapterException : Exception { public string Code { get; private set; } public AdapterException(string code, string message) : base(message) { Code = code; } }

  [StructLayout(LayoutKind.Explicit, Size = 4100)] public struct NVDRS_VALUE { [FieldOffset(0)] public uint u32Value; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct NVDRS_SETTING {
    public uint version; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=2048)] public string settingName;
    public uint settingId; public int settingType; public int settingLocation; public uint isCurrentPredefined; public uint isPredefinedValid;
    public NVDRS_VALUE predefinedValue; public NVDRS_VALUE currentValue;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct NVDRS_PROFILE {
    public uint version; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=2048)] public string profileName;
    public uint gpuSupport; public uint isPredefined; public uint numOfApps; public uint numOfSettings;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct NVDRS_APPLICATION {
    public uint version; public uint isPredefined; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=2048)] public string appName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=2048)] public string userFriendlyName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=2048)] public string launcher;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=2048)] public string fileInFolder; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=2048)] public string commandLine;
  }

  public static class Bridge {
    const int OK=0, SETTING_NOT_FOUND=-160, PROFILE_NOT_FOUND=-163, EXECUTABLE_NOT_FOUND=-166;
    static readonly HashSet<uint> Allowed = new HashSet<uint> { 0x10AFB768,0x10E41E01,0x10E41DF3,0x10E41DF5,0x10308298,0x104D6667,0x10562D0F,0x10CF4125 };
    const uint LOAD_LIBRARY_SEARCH_SYSTEM32=0x00000800;
    const uint ID_INITIALIZE=0x0150E828, ID_UNLOAD=0xD22BDD7E, ID_CREATE_SESSION=0x0694D52E, ID_DESTROY_SESSION=0xDAD9CFF8;
    const uint ID_LOAD_SETTINGS=0x375DBD6B, ID_SAVE_SETTINGS=0xFCBC7E14, ID_CREATE_PROFILE=0xCC176068, ID_DELETE_PROFILE=0x17093206;
    const uint ID_GLOBAL_PROFILE=0x617BFF9F, ID_FIND_PROFILE=0x7E4A9A0B, ID_PROFILE_INFO=0x61CD6FD6, ID_CREATE_APP=0x4347A9DE;
    const uint ID_ENUM_APPS=0x7FA2173A, ID_FIND_APP=0xEEE566B2, ID_SET_SETTING=0x577DD202, ID_GET_SETTING=0x73BF8338;
    const uint ID_ENUM_SETTINGS=0xAE3039DA, ID_DELETE_SETTING=0xE4A26362;

    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr LoadLibraryEx(string fileName, IntPtr file, uint flags);
    [DllImport("kernel32.dll", CharSet=CharSet.Ansi, SetLastError=true)] static extern IntPtr GetProcAddress(IntPtr module, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool FreeLibrary(IntPtr module);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate IntPtr QueryFn(uint id);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int SimpleFn();
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int CreateSessionFn(out IntPtr session);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int SessionFn(IntPtr session);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int ProfileFn(IntPtr session, IntPtr profile);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int CreateProfileFn(IntPtr session, ref NVDRS_PROFILE profile, out IntPtr handle);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int FindProfileFn(IntPtr session, [MarshalAs(UnmanagedType.LPWStr)] string name, out IntPtr profile);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int GetProfileFn(IntPtr session, IntPtr profile, ref NVDRS_PROFILE info);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int GetGlobalFn(IntPtr session, out IntPtr profile);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int CreateAppFn(IntPtr session, IntPtr profile, ref NVDRS_APPLICATION app);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int FindAppFn(IntPtr session, [MarshalAs(UnmanagedType.LPWStr)] string appName, out IntPtr profile, ref NVDRS_APPLICATION app);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int EnumAppsFn(IntPtr session, IntPtr profile, uint start, ref uint count, ref NVDRS_APPLICATION app);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int SettingFn(IntPtr session, IntPtr profile, ref NVDRS_SETTING setting);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int GetSettingFn(IntPtr session, IntPtr profile, uint id, ref NVDRS_SETTING setting);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int DeleteSettingFn(IntPtr session, IntPtr profile, uint id);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int EnumSettingsFn(IntPtr session, IntPtr profile, uint start, ref uint count, ref NVDRS_SETTING setting);

    sealed class Api : IDisposable {
      public IntPtr module, session; public bool initialized;
      public SimpleFn Initialize,Unload; public CreateSessionFn CreateSession; public SessionFn DestroySession,LoadSettings,SaveSettings;
      public ProfileFn DeleteProfile; public CreateProfileFn CreateProfile; public FindProfileFn FindProfile; public GetProfileFn GetProfile;
      public GetGlobalFn GetGlobal; public CreateAppFn CreateApp; public FindAppFn FindApp; public EnumAppsFn EnumApps;
      public SettingFn SetSetting; public GetSettingFn GetSetting; public DeleteSettingFn DeleteSetting; public EnumSettingsFn EnumSettings;
      T Resolve<T>(QueryFn query,uint id) where T:class { IntPtr p=query(id); if(p==IntPtr.Zero) throw new AdapterException("NVAPI_INTERFACE_UNAVAILABLE",String.Format("NvAPI interface 0x{0:X8} unavailable",id)); return Marshal.GetDelegateForFunctionPointer(p,typeof(T)) as T; }
      public Api() {
        string dll=Path.Combine(Environment.SystemDirectory,"nvapi64.dll"); module=LoadLibraryEx(dll,IntPtr.Zero,LOAD_LIBRARY_SEARCH_SYSTEM32);
        if(module==IntPtr.Zero) throw new AdapterException("NVAPI_UNAVAILABLE","nvapi64.dll is unavailable from System32.");
        IntPtr q=GetProcAddress(module,"nvapi_QueryInterface"); if(q==IntPtr.Zero) throw new AdapterException("NVAPI_UNAVAILABLE","nvapi_QueryInterface is unavailable.");
        QueryFn query=Marshal.GetDelegateForFunctionPointer(q,typeof(QueryFn)) as QueryFn;
        Initialize=Resolve<SimpleFn>(query,ID_INITIALIZE); Unload=Resolve<SimpleFn>(query,ID_UNLOAD); CreateSession=Resolve<CreateSessionFn>(query,ID_CREATE_SESSION);
        DestroySession=Resolve<SessionFn>(query,ID_DESTROY_SESSION); LoadSettings=Resolve<SessionFn>(query,ID_LOAD_SETTINGS); SaveSettings=Resolve<SessionFn>(query,ID_SAVE_SETTINGS);
        CreateProfile=Resolve<CreateProfileFn>(query,ID_CREATE_PROFILE); DeleteProfile=Resolve<ProfileFn>(query,ID_DELETE_PROFILE); FindProfile=Resolve<FindProfileFn>(query,ID_FIND_PROFILE);
        GetProfile=Resolve<GetProfileFn>(query,ID_PROFILE_INFO); GetGlobal=Resolve<GetGlobalFn>(query,ID_GLOBAL_PROFILE); CreateApp=Resolve<CreateAppFn>(query,ID_CREATE_APP);
        FindApp=Resolve<FindAppFn>(query,ID_FIND_APP); EnumApps=Resolve<EnumAppsFn>(query,ID_ENUM_APPS); SetSetting=Resolve<SettingFn>(query,ID_SET_SETTING);
        GetSetting=Resolve<GetSettingFn>(query,ID_GET_SETTING); DeleteSetting=Resolve<DeleteSettingFn>(query,ID_DELETE_SETTING); EnumSettings=Resolve<EnumSettingsFn>(query,ID_ENUM_SETTINGS);
        Check(Initialize(),"NvAPI_Initialize"); initialized=true; Check(CreateSession(out session),"NvAPI_DRS_CreateSession"); Check(LoadSettings(session),"NvAPI_DRS_LoadSettings");
      }
      public void Dispose(){ if(session!=IntPtr.Zero)try{DestroySession(session);}catch{} if(initialized)try{Unload();}catch{} if(module!=IntPtr.Zero)FreeLibrary(module); }
    }

    static uint Ver(Type t,int v){return ((uint)Marshal.SizeOf(t))|((uint)v<<16);} static NVDRS_SETTING NewSetting(){return new NVDRS_SETTING{version=Ver(typeof(NVDRS_SETTING),1),settingName=String.Empty};}
    static NVDRS_PROFILE NewProfile(){return new NVDRS_PROFILE{version=Ver(typeof(NVDRS_PROFILE),1),profileName=String.Empty};}
    static NVDRS_APPLICATION NewApp(){return new NVDRS_APPLICATION{version=Ver(typeof(NVDRS_APPLICATION),4),appName=String.Empty,userFriendlyName=String.Empty,launcher=String.Empty,fileInFolder=String.Empty,commandLine=String.Empty};}
    static void Check(int status,string op){if(status!=OK)throw new AdapterException(op=="NvAPI_DRS_SaveSettings"?"NVAPI_SAVE_FAILED":"NVAPI_FAILURE",String.Format("{0} failed ({1})",op,status));}
    static string Full(string value){if(String.IsNullOrWhiteSpace(value)||!Path.IsPathRooted(value)||!String.Equals(Path.GetExtension(value),".exe",StringComparison.OrdinalIgnoreCase))throw new AdapterException("INVALID_EXE","Invalid full EXE path.");return Path.GetFullPath(value);}
    static string OwnedName(string full){using(SHA256 sha=SHA256.Create()){byte[] h=sha.ComputeHash(Encoding.UTF8.GetBytes(full.ToLowerInvariant()));return "Zhuangjizhai DLSS5 "+BitConverter.ToString(h).Replace("-",String.Empty).Substring(0,32);}}
    sealed class Found { public IntPtr handle; public NVDRS_PROFILE info; public NVDRS_APPLICATION app; public bool global; public bool exclusive; public bool owned; }
    static Found Find(Api api,string full){NVDRS_APPLICATION app=NewApp();IntPtr handle;int s=api.FindApp(api.session,full,out handle,ref app);if(s==EXECUTABLE_NOT_FOUND||s==PROFILE_NOT_FOUND)return null;if(s!=OK)throw new AdapterException("PROFILE_LOOKUP_FAILED",String.Format("NvAPI_DRS_FindApplicationByName failed ({0})",s));NVDRS_PROFILE info=NewProfile();Check(api.GetProfile(api.session,handle,ref info),"NvAPI_DRS_GetProfileInfo");IntPtr global;Check(api.GetGlobal(api.session,out global),"NvAPI_DRS_GetCurrentGlobalProfile");bool exact=String.Equals(Path.GetFullPath(app.appName??String.Empty),full,StringComparison.OrdinalIgnoreCase);bool exclusive=info.numOfApps==1&&exact;return new Found{handle=handle,info=info,app=app,global=handle==global,exclusive=exclusive,owned=exclusive&&info.isPredefined==0&&String.Equals(info.profileName,OwnedName(full),StringComparison.Ordinal)};}
    static SettingState ReadSetting(Api api,IntPtr profile,uint id,bool inheritedContext=false){NVDRS_SETTING s=NewSetting();int rc=api.GetSetting(api.session,profile,id,ref s);if(rc==SETTING_NOT_FOUND)return new SettingState{kind="absent",value=null,location=null,predefined=null};Check(rc,String.Format("NvAPI_DRS_GetSetting 0x{0:X8}",id));if(s.settingLocation<0||s.settingLocation>3)throw new AdapterException("UNSUPPORTED_SETTING_LOCATION",String.Format("Setting 0x{0:X8} has unknown location {1}.",id,s.settingLocation));bool explicitValue=!inheritedContext&&s.settingLocation==0&&s.isCurrentPredefined==0;int location=inheritedContext&&s.settingLocation==0?1:s.settingLocation;return new SettingState{kind=explicitValue?"explicit":"inherited",value=s.currentValue.u32Value,location=location,predefined=s.isCurrentPredefined!=0};}
    static Snapshot ReadSnapshot(Api api,string full,uint[] ids,out Found found){found=Find(api,full);Snapshot snap=new Snapshot{settings=new Dictionary<string,SettingState>()};if(found==null){snap.profile=null;IntPtr global;Check(api.GetGlobal(api.session,out global),"NvAPI_DRS_GetCurrentGlobalProfile");foreach(uint id in ids)snap.settings[id.ToString()]=ReadSetting(api,global,id,true);return snap;}snap.profile=new ProfileState{name=found.info.profileName??String.Empty,appName=found.app.appName??String.Empty,exclusive=found.exclusive,owned=found.owned};foreach(uint id in ids)snap.settings[id.ToString()]=ReadSetting(api,found.handle,id);return snap;}
    static bool SameSetting(SettingState a,SettingState b){return a!=null&&b!=null&&a.kind==b.kind&&a.value==b.value&&a.location==b.location&&a.predefined==b.predefined;}
    static bool SameProfile(ProfileState a,ProfileState b){if(a==null||b==null)return a==null&&b==null;return a.name==b.name&&String.Equals(a.appName,b.appName,StringComparison.OrdinalIgnoreCase)&&a.exclusive==b.exclusive&&a.owned==b.owned;}
    static bool IsDerivedOwnedProfile(ProfileState value,string full){try{return value!=null&&value.exclusive&&value.owned&&String.Equals(value.name,OwnedName(full),StringComparison.Ordinal)&&String.Equals(Path.GetFullPath(value.appName??String.Empty),full,StringComparison.OrdinalIgnoreCase);}catch{return false;}}
    static bool Same(Snapshot a,Snapshot b,uint[] ids){if(a==null||b==null||!SameProfile(a.profile,b.profile)||a.settings==null||b.settings==null)return false;foreach(uint id in ids){SettingState x,y;if(!a.settings.TryGetValue(id.ToString(),out x)||!b.settings.TryGetValue(id.ToString(),out y)||!SameSetting(x,y))return false;}return true;}
    static void Validate(Request r){if(r==null||!(r.op=="read"||r.op=="write"))throw new AdapterException("INVALID_REQUEST","Invalid operation.");if(r.ids==null||r.ids.Length==0||r.ids.Distinct().Count()!=r.ids.Length||r.ids.Any(x=>!Allowed.Contains(x)))throw new AdapterException("UNSUPPORTED_SETTING","The request contains a driver key outside the allowlist.");}
    static Found CreateOwned(Api api,string full){string name=OwnedName(full);IntPtr existing;int s=api.FindProfile(api.session,name,out existing);if(s==OK)throw new AdapterException("PROFILE_OWNERSHIP_CONFLICT","A profile with the owned name already exists; ownership is ambiguous.");if(s!=PROFILE_NOT_FOUND)throw new AdapterException("PROFILE_LOOKUP_FAILED",String.Format("NvAPI_DRS_FindProfileByName failed ({0})",s));NVDRS_PROFILE p=NewProfile();p.profileName=name;p.gpuSupport=1;IntPtr handle;Check(api.CreateProfile(api.session,ref p,out handle),"NvAPI_DRS_CreateProfile");NVDRS_APPLICATION app=NewApp();app.appName=full;app.userFriendlyName=name;Check(api.CreateApp(api.session,handle,ref app),"NvAPI_DRS_CreateApplication");return new Found{handle=handle,info=p,app=app,exclusive=true,owned=true,global=false};}
    static void Set(Api api,IntPtr profile,uint id,uint value){NVDRS_SETTING s=NewSetting();s.settingId=id;s.settingType=0;s.currentValue.u32Value=value;Check(api.SetSetting(api.session,profile,ref s),String.Format("NvAPI_DRS_SetSetting 0x{0:X8}",id));}
    static void Delete(Api api,IntPtr profile,uint id){int s=api.DeleteSetting(api.session,profile,id);if(s!=OK&&s!=SETTING_NOT_FOUND)throw new AdapterException("NVAPI_FAILURE",String.Format("NvAPI_DRS_DeleteProfileSetting 0x{0:X8} failed ({1})",id,s));}
    static HashSet<uint> ExplicitIds(Api api,Found found){HashSet<uint> result=new HashSet<uint>();for(uint i=0;i<found.info.numOfSettings;i++){uint count=1;NVDRS_SETTING s=NewSetting();Check(api.EnumSettings(api.session,found.handle,i,ref count,ref s),"NvAPI_DRS_EnumSettings");if(count==1&&s.settingLocation==0&&s.isCurrentPredefined==0)result.Add(s.settingId);}return result;}

    static Snapshot Write(Api api,string full,Request r){Found found;Snapshot current=ReadSnapshot(api,full,r.ids,out found);if(!Same(current,r.expectedSnapshot,r.ids))throw new AdapterException("NVAPI_CAS_MISMATCH","Driver profile changed after the expected snapshot was captured.");bool hasExplicit=r.ids.Any(id=>r.desiredSnapshot.settings[id.ToString()].kind=="explicit");bool wantsProfile=r.desiredSnapshot.profile!=null||hasExplicit;if(found!=null&&(found.global||!found.exclusive))throw new AdapterException("UNSAFE_PROFILE","Refusing a global, shared, or non-unique full-path profile.");if(found!=null&&wantsProfile&&(r.desiredSnapshot.profile==null||!SameProfile(current.profile,r.desiredSnapshot.profile)))throw new AdapterException("INVALID_PROFILE_TARGET","An existing profile must retain its exact identity.");if(found==null&&r.desiredSnapshot.profile!=null&&!IsDerivedOwnedProfile(r.desiredSnapshot.profile,full))throw new AdapterException("INVALID_PROFILE_TARGET","Only the exact path-derived owned profile can be recreated.");if(found==null&&wantsProfile)found=CreateOwned(api,full);if(found==null){if(!Same(current,r.desiredSnapshot,r.ids))throw new AdapterException("INVALID_RESTORE","A missing application profile can only retain its inherited state.");return current;}
      bool deleteProfile=!wantsProfile&&r.desiredSnapshot.profile==null;if(deleteProfile){if(!found.owned)throw new AdapterException("PROFILE_NOT_OWNED","Only an exclusive tool-created profile can be deleted.");HashSet<uint> remaining=ExplicitIds(api,found);foreach(uint id in r.ids)if(r.desiredSnapshot.settings[id.ToString()].kind!="explicit")remaining.Remove(id);if(remaining.Count!=0)throw new AdapterException("PROFILE_NOT_EMPTY","The profile contains explicit settings outside this restore operation.");}
      foreach(uint id in r.ids){SettingState target=r.desiredSnapshot.settings[id.ToString()];if(SameSetting(current.settings[id.ToString()],target))continue;if(target.kind=="explicit"){if(!target.value.HasValue)throw new AdapterException("INVALID_REQUEST","An explicit DWORD setting needs a value.");Set(api,found.handle,id,target.value.Value);}else Delete(api,found.handle,id);}
      if(deleteProfile)Check(api.DeleteProfile(api.session,found.handle),"NvAPI_DRS_DeleteProfile");Check(api.SaveSettings(api.session),"NvAPI_DRS_SaveSettings");Check(api.LoadSettings(api.session),"NvAPI_DRS_LoadSettings(readback)");Snapshot actual=ReadSnapshot(api,full,r.ids,out found);
      if(deleteProfile){if(!Same(actual,r.desiredSnapshot,r.ids))throw new AdapterException("NVAPI_READBACK_MISMATCH","The deleted profile did not read back as absent.");}else{if(actual.profile==null)throw new AdapterException("NVAPI_READBACK_MISMATCH","The profile disappeared after save.");if(r.desiredSnapshot.profile!=null&&!SameProfile(actual.profile,r.desiredSnapshot.profile))throw new AdapterException("NVAPI_READBACK_MISMATCH","The recreated profile identity did not match the requested owned profile.");foreach(uint id in r.ids){SettingState target=r.desiredSnapshot.settings[id.ToString()];if(!SameSetting(actual.settings[id.ToString()],target))throw new AdapterException("NVAPI_READBACK_MISMATCH",String.Format("Setting 0x{0:X8} did not read back as requested.",id));}}
      return actual;
    }

    public static string Layout(){int a=Marshal.SizeOf(typeof(NVDRS_SETTING)),b=Marshal.SizeOf(typeof(NVDRS_PROFILE)),c=Marshal.SizeOf(typeof(NVDRS_APPLICATION));if(a!=12320||b!=4116||c!=20492)throw new AdapterException("NVAPI_LAYOUT_MISMATCH",String.Format("Unexpected NvAPI struct layout {0}/{1}/{2}",a,b,c));return String.Format("NVDRS_SETTING={0};NVDRS_PROFILE={1};NVDRS_APPLICATION_V4={2}",a,b,c);}
    public static string Execute(string json){JavaScriptSerializer js=new JavaScriptSerializer{MaxJsonLength=4*1024*1024,RecursionLimit=64};try{Request r=js.Deserialize<Request>(json);Validate(r);string full=Full(r.exe);using(Api api=new Api()){Found f;Snapshot s=r.op=="read"?ReadSnapshot(api,full,r.ids,out f):Write(api,full,r);return js.Serialize(new Response{ok=true,snapshot=s});}}catch(AdapterException e){return js.Serialize(new Response{ok=false,code=e.Code,error=e.Message});}catch(Exception e){return js.Serialize(new Response{ok=false,code="NVAPI_HELPER_EXCEPTION",error=e.Message});}}
  }
}
'@
try {
  Add-Type -TypeDefinition $source -Language CSharp -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll') -ErrorAction Stop
  if ($Action -eq 'selftest') {
    @{ok=$true;layout=[ZhuangjizhaiNvapiProfile.Bridge]::Layout()} | ConvertTo-Json -Compress
    exit 0
  }
  if ($env:DLSS5_NVAPI_REQUEST) {
    $utf8 = [Text.UTF8Encoding]::new($false, $true)
    $request = $utf8.GetString([Convert]::FromBase64String($env:DLSS5_NVAPI_REQUEST))
  } else {
    $request = [Console]::In.ReadToEnd()
  }
  $result = [ZhuangjizhaiNvapiProfile.Bridge]::Execute($request)
  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
  [Console]::Out.WriteLine($result)
  if (($result | ConvertFrom-Json).ok) { exit 0 }
  exit 2
} catch {
  @{ok=$false;code='NVAPI_COMPILE_FAILED';error=$_.Exception.Message} | ConvertTo-Json -Compress
  exit 1
}
